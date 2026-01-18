import type { VectorRepository } from "../database/repositories/VectorRepository";
import type { EmbeddingService } from "./EmbeddingService";
import { cosineSimilarity } from "../utils/vector";
import type { Logger } from "../utils/Logger";
import { DEFAULT_SEARCH_LIMIT, DEFAULT_MIN_SIMILARITY } from "../config/constants";

export interface SemanticSearchResult {
	chunkId: string;
	noteId: string;
	title: string;
	filePath: string;
	heading: string | null;
	startLine: number;
	similarity: number;
}

export interface SimilarNote {
	noteId: string;
	title: string;
	filePath: string;
	similarity: number;
}

export class VectorService {
	private vectorRepo: VectorRepository;
	private embeddingService: EmbeddingService;
	private logger: Logger | null;

	constructor(
		vectorRepo: VectorRepository,
		embeddingService: EmbeddingService,
		logger: Logger | null = null
	) {
		this.vectorRepo = vectorRepo;
		this.embeddingService = embeddingService;
		this.logger = logger;
	}

	/**
	 * Search chunks by semantic similarity to a query string.
	 * Returns individual chunk results (not aggregated by note).
	 */
	async search(
		query: string,
		limit: number = DEFAULT_SEARCH_LIMIT
	): Promise<SemanticSearchResult[]> {
		if (!query.trim()) {
			return [];
		}

		this.logger?.debug("VectorService: Starting semantic search for:", query);

		// Get query embedding
		const queryEmbedding = await this.embeddingService.embedSingle(query);
		this.logger?.debug("VectorService: Got query embedding, dimensions:", queryEmbedding.length);

		// Get all chunk embeddings with note info
		const chunksWithEmbeddings = this.vectorRepo.getAllChunkEmbeddingsWithChunks();
		this.logger?.debug("VectorService: Chunks with valid embeddings:", chunksWithEmbeddings.length);

		if (chunksWithEmbeddings.length === 0) {
			this.logger?.warn("VectorService: No chunks with matching content_hash found!");
			return [];
		}

		// Calculate similarity for each chunk
		const results: SemanticSearchResult[] = [];

		for (const chunk of chunksWithEmbeddings) {
			const similarity = cosineSimilarity(queryEmbedding, chunk.vector);

			if (similarity >= DEFAULT_MIN_SIMILARITY) {
				results.push({
					chunkId: chunk.chunkId,
					noteId: chunk.noteId,
					title: chunk.noteTitle,
					filePath: chunk.filePath,
					heading: chunk.heading,
					startLine: chunk.startLine,
					similarity,
				});
			}
		}

		// Sort by similarity descending
		results.sort((a, b) => b.similarity - a.similarity);
		return results.slice(0, limit);
	}

	/**
	 * Get similar notes for a given note ID.
	 * Uses chunk embeddings - finds similar chunks from other notes and aggregates.
	 * @param noteId The note ID to find similar notes for
	 * @param limit Maximum number of results
	 * @param minSimilarity Minimum similarity threshold (0-1), defaults to 0.3
	 */
	getSimilarNotes(
		noteId: string,
		limit: number = DEFAULT_SEARCH_LIMIT,
		minSimilarity: number = DEFAULT_MIN_SIMILARITY
	): SimilarNote[] {
		// Get the target note's chunk embeddings
		const targetChunks = this.vectorRepo.getChunkEmbeddingsForNote(noteId);
		if (targetChunks.length === 0) {
			return [];
		}

		// Get all chunk embeddings
		const allChunks = this.vectorRepo.getAllChunkEmbeddingsWithChunks();

		// Track best similarity per note
		const noteSimilarities = new Map<string, { similarity: number; title: string; filePath: string }>();

		// For each target chunk, find similar chunks from other notes
		for (const targetChunk of targetChunks) {
			for (const chunk of allChunks) {
				// Skip chunks from the same note
				if (chunk.noteId === noteId) {
					continue;
				}

				const similarity = cosineSimilarity(targetChunk.vector, chunk.vector);

				if (similarity >= minSimilarity) {
					const existing = noteSimilarities.get(chunk.noteId);
					if (!existing || similarity > existing.similarity) {
						noteSimilarities.set(chunk.noteId, {
							similarity,
							title: chunk.noteTitle,
							filePath: chunk.filePath,
						});
					}
				}
			}
		}

		// Convert to array and sort
		const results: SimilarNote[] = [];
		for (const [nId, data] of noteSimilarities) {
			results.push({
				noteId: nId,
				title: data.title,
				filePath: data.filePath,
				similarity: data.similarity,
			});
		}

		results.sort((a, b) => b.similarity - a.similarity);
		return results.slice(0, limit);
	}

	/**
	 * Check if a note has any embeddings.
	 */
	hasEmbeddings(noteId: string): boolean {
		return this.vectorRepo.hasEmbeddingsForNote(noteId);
	}

	/**
	 * Check if there are any embeddings in the database.
	 */
	hasAnyEmbeddings(): boolean {
		return this.vectorRepo.hasAnyEmbeddings();
	}

	/**
	 * Get embedding statistics.
	 */
	getStats(): { total: number; embedded: number; pending: number } {
		return this.vectorRepo.getEmbeddingCounts();
	}
}
