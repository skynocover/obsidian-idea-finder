import { requestUrl, type App, type RequestUrlResponse } from "obsidian";
import type { VectorRepository } from "../database/repositories/VectorRepository";
import type { NoteRepository } from "../database/repositories/NoteRepository";
import type { ChunkRepository } from "../database/repositories/ChunkRepository";
import type { Chunk } from "../types";
import { sleep } from "../utils/vector";
import { readFileContent } from "../utils/file";
import type { Logger } from "../utils/Logger";
import {
	RateLimitError,
	AuthenticationError,
	QuotaExceededError,
	ServerError,
	NetworkError,
	TimeoutError,
	ConfigurationError,
	ConcurrencyError,
	type EmbeddingError,
} from "../errors";
import {
	JINA_API_URL,
	JINA_MODEL,
	API_BATCH_SIZE,
	MAX_TEXT_LENGTH,
	API_JITTER_MS,
} from "../config/constants";

// Exponential backoff configuration
const BACKOFF_CONFIG = {
	initialDelayMs: 1000,
	maxDelayMs: 60000,
	factor: 2,
	maxRetries: 5,
};

interface JinaEmbeddingResponse {
	data: Array<{
		index: number;
		embedding: number[];
	}>;
	usage: {
		total_tokens: number;
	};
}

export interface EmbeddingProgress {
	current: number;
	total: number;
	status: "idle" | "running" | "completed" | "error";
	error?: string;
}

export class EmbeddingService {
	private app: App;
	private noteRepo: NoteRepository;
	private vectorRepo: VectorRepository;
	private chunkRepo: ChunkRepository | null;
	private apiKey: string;
	private isRunning = false;
	private abortRequested = false;
	private currentRetryAttempt = 0;
	private logger: Logger | null;

	constructor(
		app: App,
		noteRepo: NoteRepository,
		vectorRepo: VectorRepository,
		apiKey: string,
		chunkRepo: ChunkRepository | null = null,
		logger: Logger | null = null
	) {
		this.app = app;
		this.noteRepo = noteRepo;
		this.vectorRepo = vectorRepo;
		this.chunkRepo = chunkRepo;
		this.apiKey = apiKey;
		this.logger = logger;
	}

	setApiKey(apiKey: string): void {
		this.apiKey = apiKey;
	}

	/**
	 * Calculate delay for exponential backoff
	 */
	private calculateBackoffDelay(attempt: number): number {
		const delay = BACKOFF_CONFIG.initialDelayMs * Math.pow(BACKOFF_CONFIG.factor, attempt);
		return Math.min(delay, BACKOFF_CONFIG.maxDelayMs);
	}

	/**
	 * Execute with exponential backoff retry logic
	 */
	private async withRetry<T>(
		fn: () => Promise<T>,
		onRetry?: (attempt: number, delay: number, error: EmbeddingError) => void
	): Promise<T> {
		let lastError: EmbeddingError | Error | null = null;

		for (let attempt = 0; attempt <= BACKOFF_CONFIG.maxRetries; attempt++) {
			try {
				const result = await fn();
				this.currentRetryAttempt = 0; // Reset on success
				return result;
			} catch (error) {
				lastError = error as EmbeddingError | Error;

				// Check if error is retryable
				const isRetryable = error instanceof RateLimitError ||
					error instanceof ServerError ||
					error instanceof NetworkError ||
					error instanceof TimeoutError;

				if (!isRetryable || attempt >= BACKOFF_CONFIG.maxRetries) {
					throw error;
				}

				// Calculate delay with jitter
				const baseDelay = error instanceof RateLimitError
					? error.retryAfterMs
					: this.calculateBackoffDelay(attempt);
				const jitter = Math.random() * API_JITTER_MS;
				const delay = baseDelay + jitter;

				this.logger?.debug(`Embedding: Retry attempt ${attempt + 1}/${BACKOFF_CONFIG.maxRetries}, waiting ${Math.round(delay)}ms...`);
				onRetry?.(attempt + 1, delay, error as EmbeddingError);

				await sleep(delay);
			}
		}

		throw lastError;
	}

	/**
	 * Generate embeddings for all notes that need them.
	 */
	async generateAll(
		onProgress?: (progress: EmbeddingProgress) => void
	): Promise<{ success: number; failed: number }> {
		if (this.isRunning) {
			throw new ConcurrencyError();
		}

		if (!this.apiKey) {
			throw new ConfigurationError();
		}

		this.isRunning = true;
		this.abortRequested = false;

		const notesNeedingEmbedding = this.vectorRepo.getNotesNeedingEmbedding();
		const total = notesNeedingEmbedding.length;
		let success = 0;
		let failed = 0;

		onProgress?.({ current: 0, total, status: "running" });

		try {
			// Process in batches
			for (let i = 0; i < notesNeedingEmbedding.length; i += API_BATCH_SIZE) {
				if (this.abortRequested) {
					break;
				}

				const batch = notesNeedingEmbedding.slice(i, i + API_BATCH_SIZE);

				// Read content from vault for each note
				const textsWithContent: Array<{ note: typeof batch[0]; content: string }> = [];
				for (const note of batch) {
					const content = await readFileContent(this.app, note.filePath);
					if (content !== null) {
						textsWithContent.push({
							note,
							content: content.length > MAX_TEXT_LENGTH
								? content.slice(0, MAX_TEXT_LENGTH)
								: content,
						});
					}
				}

				if (textsWithContent.length === 0) {
					continue; // Skip if no content could be read
				}

				const texts = textsWithContent.map((item) => item.content);

				try {
					// Use retry wrapper with exponential backoff
					const embeddings = await this.withRetry(
						() => this.embed(texts),
						(attempt, delay, error) => {
							this.logger?.debug(`Embedding: Batch retry ${attempt}: ${error.code} - waiting ${Math.round(delay / 1000)}s`);
						}
					);

					// Save embeddings to database
					for (let j = 0; j < textsWithContent.length; j++) {
						const { note } = textsWithContent[j];
						const embedding = embeddings[j];
						if (embedding) {
							this.vectorRepo.upsertNoteEmbedding(note.id, embedding, note.contentHash);
							success++;
						}
					}
				} catch (error) {
					this.logger?.error("Embedding: Batch failed:", error);
					failed += batch.length;

					// Non-retryable errors should stop the entire process
					if (error instanceof AuthenticationError || error instanceof QuotaExceededError) {
						onProgress?.({
							current: i,
							total,
							status: "error",
							error: error instanceof Error ? error.message : "Unknown error",
						});
						throw error;
					}
				}

				onProgress?.({
					current: Math.min(i + API_BATCH_SIZE, total),
					total,
					status: "running",
				});

				// Small delay between batches to avoid rate limiting
				if (i + API_BATCH_SIZE < notesNeedingEmbedding.length) {
					await sleep(500);
				}
			}

			onProgress?.({
				current: total,
				total,
				status: this.abortRequested ? "idle" : "completed",
			});

			return { success, failed };
		} finally {
			this.isRunning = false;
		}
	}

	/**
	 * Generate embeddings for all chunks that need them.
	 * This is the primary method for chunk-based semantic search.
	 */
	async generateChunkEmbeddings(
		onProgress?: (progress: EmbeddingProgress) => void
	): Promise<{ success: number; failed: number }> {
		if (this.isRunning) {
			throw new ConcurrencyError();
		}

		if (!this.apiKey) {
			throw new ConfigurationError();
		}

		if (!this.chunkRepo) {
			throw new ConfigurationError("Chunk repository not configured");
		}

		this.isRunning = true;
		this.abortRequested = false;

		const chunksNeedingEmbedding = this.chunkRepo.getChunksNeedingEmbeddings();
		const total = chunksNeedingEmbedding.length;
		let success = 0;
		let failed = 0;

		onProgress?.({ current: 0, total, status: "running" });

		try {
			// Process in batches
			for (let i = 0; i < chunksNeedingEmbedding.length; i += API_BATCH_SIZE) {
				if (this.abortRequested) {
					break;
				}

				const batch = chunksNeedingEmbedding.slice(i, i + API_BATCH_SIZE);

				// Prepare texts for embedding (chunk content is already stored in DB)
				const textsWithChunk: Array<{ chunk: Chunk; content: string }> = [];
				for (const chunk of batch) {
					// Truncate if needed
					const content = chunk.content.length > MAX_TEXT_LENGTH
						? chunk.content.slice(0, MAX_TEXT_LENGTH)
						: chunk.content;
					textsWithChunk.push({ chunk, content });
				}

				if (textsWithChunk.length === 0) {
					continue;
				}

				const texts = textsWithChunk.map((item) => item.content);

				try {
					// Use retry wrapper with exponential backoff
					const embeddings = await this.withRetry(
						() => this.embed(texts),
						(attempt, delay, error) => {
							this.logger?.debug(`Embedding: Chunk batch retry ${attempt}: ${error.code} - waiting ${Math.round(delay / 1000)}s`);
						}
					);

					// Save embeddings to database
					for (let j = 0; j < textsWithChunk.length; j++) {
						const { chunk } = textsWithChunk[j];
						const embedding = embeddings[j];
						if (embedding) {
							this.vectorRepo.upsertChunkEmbedding({
								chunkId: chunk.id,
								vector: embedding,
								contentHash: chunk.contentHash,
							});
							success++;
						}
					}
				} catch (error) {
					this.logger?.error("Embedding: Chunk batch failed:", error);
					failed += batch.length;

					// Non-retryable errors should stop the entire process
					if (error instanceof AuthenticationError || error instanceof QuotaExceededError) {
						onProgress?.({
							current: i,
							total,
							status: "error",
							error: error instanceof Error ? error.message : "Unknown error",
						});
						throw error;
					}
				}

				onProgress?.({
					current: Math.min(i + API_BATCH_SIZE, total),
					total,
					status: "running",
				});

				// Small delay between batches to avoid rate limiting
				if (i + API_BATCH_SIZE < chunksNeedingEmbedding.length) {
					await sleep(500);
				}
			}

			onProgress?.({
				current: total,
				total,
				status: this.abortRequested ? "idle" : "completed",
			});

			return { success, failed };
		} finally {
			this.isRunning = false;
		}
	}

	/**
	 * Check if chunk embeddings are available.
	 */
	hasChunkEmbeddings(): boolean {
		return this.vectorRepo.hasAnyChunkEmbeddings();
	}

	/**
	 * Get chunk embedding statistics.
	 */
	getChunkEmbeddingCounts(): { totalChunks: number; embedded: number; pending: number } {
		return this.vectorRepo.getChunkEmbeddingCounts();
	}

	/**
	 * Generate embedding for a single text.
	 */
	async embedSingle(text: string): Promise<number[]> {
		const embeddings = await this.embed([text]);
		return embeddings[0];
	}

	/**
	 * Call Jina API to generate embeddings.
	 */
	private async embed(texts: string[]): Promise<number[][]> {
		if (!this.apiKey) {
			throw new ConfigurationError("API key not configured");
		}

		let response: RequestUrlResponse;
		try {
			response = await requestUrl({
				url: JINA_API_URL,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.apiKey}`,
				},
				body: JSON.stringify({
					model: JINA_MODEL,
					input: texts,
				}),
			});
		} catch (error) {
			// Convert network errors to structured types
			if (error instanceof Error) {
				const msg = error.message.toLowerCase();
				if (msg.includes("fetch") || msg.includes("network") || msg.includes("failed")) {
					throw new NetworkError("Network error: Please check your internet connection");
				}
				if (msg.includes("timeout")) {
					throw new TimeoutError("Request timeout: The server took too long to respond");
				}
				if (msg.includes("abort")) {
					throw new NetworkError("Request cancelled");
				}
				throw new NetworkError(`Connection error: ${error.message}`);
			}
			throw error;
		}

		if (response.status === 401) {
			throw new AuthenticationError("Invalid API key: Please check your Jina API key in settings");
		}

		if (response.status === 429) {
			// Extract retry-after header if available, default to 60s
			const retryAfter = 60000;
			throw new RateLimitError(retryAfter, "Rate limit exceeded: Too many requests");
		}

		if (response.status === 402) {
			throw new QuotaExceededError("API quota exceeded: Please check your Jina account billing");
		}

		if (response.status === 500 || response.status === 502 || response.status === 503) {
			throw new ServerError(response.status, "Jina API is temporarily unavailable. Please try again later");
		}

		if (response.status !== 200) {
			throw new ServerError(response.status, `Jina API error (${response.status}): Unexpected error occurred`);
		}

		const data: JinaEmbeddingResponse = response.json;

		// Sort by index to ensure correct order
		const sortedData = data.data.sort((a, b) => a.index - b.index);
		return sortedData.map((item) => item.embedding);
	}

	/**
	 * Test API connection.
	 */
	async testConnection(): Promise<{ success: boolean; error?: string }> {
		if (!this.apiKey) {
			return { success: false, error: "API Key not configured" };
		}

		try {
			await this.embed(["test"]);
			return { success: true };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	/**
	 * Abort the current embedding generation.
	 */
	abort(): void {
		this.abortRequested = true;
	}

	isGenerating(): boolean {
		return this.isRunning;
	}
}
