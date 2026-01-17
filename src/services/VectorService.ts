import type { VectorRepository } from "../database/repositories/VectorRepository";
import type { EmbeddingService } from "./EmbeddingService";
import { cosineSimilarity } from "../utils/vector";
import type { Logger } from "../utils/Logger";
import { DEFAULT_SEARCH_LIMIT, DEFAULT_MIN_SIMILARITY } from "../config/constants";

export interface SemanticSearchResult {
	noteId: string;
	title: string;
	filePath: string;
	similarity: number;
}

export interface ChunkSearchResult {
	chunkId: string;
	noteId: string;
	noteTitle: string;
	filePath: string;
	heading: string | null;
	headingLevel: number | null;
	content: string;
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
	 * Search notes by semantic similarity to a query string.
	 */
	async searchByQuery(
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

		// Get all note embeddings
		const notesWithEmbeddings = this.vectorRepo.getAllNoteEmbeddingsWithNotes();
		this.logger?.debug("VectorService: Notes with valid embeddings:", notesWithEmbeddings.length);

		if (notesWithEmbeddings.length === 0) {
			this.logger?.warn("VectorService: No notes with matching content_hash found!");
			return [];
		}

		// Calculate similarity for each note
		const results: SemanticSearchResult[] = [];

		for (const note of notesWithEmbeddings) {
			const similarity = cosineSimilarity(queryEmbedding, note.vector);

			if (similarity >= DEFAULT_MIN_SIMILARITY) {
				results.push({
					noteId: note.noteId,
					title: note.title,
					filePath: note.filePath,
					similarity,
				});
			}
		}

		// Sort by similarity (descending) and limit
		results.sort((a, b) => b.similarity - a.similarity);
		return results.slice(0, limit);
	}

	/**
	 * Get similar notes for a given note ID.
	 * @param noteId The note ID to find similar notes for
	 * @param limit Maximum number of results
	 * @param minSimilarity Minimum similarity threshold (0-1), defaults to 0.3
	 */
	getSimilarNotes(
		noteId: string,
		limit: number = DEFAULT_SEARCH_LIMIT,
		minSimilarity: number = DEFAULT_MIN_SIMILARITY
	): SimilarNote[] {
		// Get the target note's embedding
		const targetEmbedding = this.vectorRepo.getNoteEmbedding(noteId);
		if (!targetEmbedding) {
			return [];
		}

		// Get all note embeddings
		const notesWithEmbeddings = this.vectorRepo.getAllNoteEmbeddingsWithNotes();

		// Calculate similarity for each note (excluding target)
		const results: SimilarNote[] = [];

		for (const note of notesWithEmbeddings) {
			// Skip the target note itself
			if (note.noteId === noteId) {
				continue;
			}

			const similarity = cosineSimilarity(targetEmbedding.vector, note.vector);

			if (similarity >= minSimilarity) {
				results.push({
					noteId: note.noteId,
					title: note.title,
					filePath: note.filePath,
					similarity,
				});
			}
		}

		// Sort by similarity (descending) and limit
		results.sort((a, b) => b.similarity - a.similarity);
		return results.slice(0, limit);
	}

	/**
	 * Check if a note has an embedding.
	 */
	hasEmbedding(noteId: string): boolean {
		return this.vectorRepo.getNoteEmbedding(noteId) !== null;
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
		return this.vectorRepo.getNoteEmbeddingCounts();
	}

	/**
	 * Search chunks by semantic similarity to a query string.
	 * This provides more granular results than note-level search.
	 */
	async searchChunksByQuery(
		query: string,
		limit: number = DEFAULT_SEARCH_LIMIT
	): Promise<ChunkSearchResult[]> {
		if (!query.trim()) {
			return [];
		}

		this.logger?.debug("VectorService: Starting chunk search for:", query);

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
		const results: ChunkSearchResult[] = [];

		for (const chunk of chunksWithEmbeddings) {
			const similarity = cosineSimilarity(queryEmbedding, chunk.vector);

			if (similarity >= DEFAULT_MIN_SIMILARITY) {
				results.push({
					chunkId: chunk.chunkId,
					noteId: chunk.noteId,
					noteTitle: chunk.noteTitle,
					filePath: chunk.filePath,
					heading: chunk.heading,
					headingLevel: chunk.headingLevel,
					content: chunk.content,
					startLine: chunk.startLine,
					similarity,
				});
			}
		}

		// Sort by similarity (descending) and limit
		results.sort((a, b) => b.similarity - a.similarity);
		return results.slice(0, limit);
	}

	/**
	 * Smart search: Use chunk embeddings if available, otherwise fall back to note embeddings.
	 * Returns SemanticSearchResult[] to maintain API compatibility.
	 */
	async smartSearch(
		query: string,
		limit: number = DEFAULT_SEARCH_LIMIT
	): Promise<SemanticSearchResult[]> {
		// If chunk embeddings are available, use them
		if (this.vectorRepo.hasAnyChunkEmbeddings()) {
			const chunkResults = await this.searchChunksByQuery(query, limit * 2);

			// Aggregate chunk results by note (take best chunk per note)
			const noteMap = new Map<string, SemanticSearchResult>();
			for (const chunk of chunkResults) {
				const existing = noteMap.get(chunk.noteId);
				if (!existing || chunk.similarity > existing.similarity) {
					noteMap.set(chunk.noteId, {
						noteId: chunk.noteId,
						title: chunk.noteTitle,
						filePath: chunk.filePath,
						similarity: chunk.similarity,
					});
				}
			}

			// Convert to array and sort
			const results = Array.from(noteMap.values());
			results.sort((a, b) => b.similarity - a.similarity);
			return results.slice(0, limit);
		}

		// Fall back to note-level search
		return this.searchByQuery(query, limit);
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
	getChunkStats(): { totalChunks: number; embedded: number; pending: number } {
		return this.vectorRepo.getChunkEmbeddingCounts();
	}
}
