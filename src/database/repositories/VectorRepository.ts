import type { Database } from "sql.js";
import type { Embedding, NoteWithEmbedding, ChunkEmbedding, ChunkWithNote } from "../../types";
import type { EmbeddingRow, ChunkEmbeddingRow, NoteWithEmbeddingRow, ChunkWithNoteRow } from "../sql-types";
import { vectorToBlob, blobToVector } from "../../utils/vector";
import { runQuery, querySingle, queryMany, runBatchedQuery, rowExists } from "../utils";

/**
 * Unified repository for all vector operations (note-level and chunk-level embeddings).
 */
export class VectorRepository {
	constructor(private getDb: () => Database) {}

	// ========================================
	// Note-level embeddings
	// ========================================

	/**
	 * Upsert a note-level embedding.
	 */
	upsertNoteEmbedding(noteId: string, vector: number[], contentHash: string): void {
		const db = this.getDb();
		const vectorBlob = vectorToBlob(vector);
		const exists = rowExists(db, "SELECT note_id FROM embeddings WHERE note_id = ?", [noteId]);

		if (exists) {
			runQuery(
				db,
				`UPDATE embeddings SET vector = ?, content_hash = ? WHERE note_id = ?`,
				[vectorBlob, contentHash, noteId]
			);
		} else {
			runQuery(
				db,
				`INSERT INTO embeddings (note_id, vector, content_hash) VALUES (?, ?, ?)`,
				[noteId, vectorBlob, contentHash]
			);
		}
	}

	/**
	 * Get note embedding by note ID.
	 */
	getNoteEmbedding(noteId: string): Embedding | null {
		return querySingle(
			this.getDb(),
			"SELECT note_id, vector, content_hash FROM embeddings WHERE note_id = ?",
			[noteId],
			(row) => {
				const r = row as unknown as EmbeddingRow;
				return {
					noteId: r.note_id,
					vector: blobToVector(r.vector),
					contentHash: r.content_hash,
				};
			}
		);
	}

	/**
	 * Get all note embeddings with note info for semantic search.
	 * Only returns embeddings where content_hash matches (embedding is valid).
	 */
	getAllNoteEmbeddingsWithNotes(): NoteWithEmbedding[] {
		return queryMany(
			this.getDb(),
			`SELECT e.note_id, e.vector, n.title, n.file_path
			FROM embeddings e
			JOIN notes n ON e.note_id = n.id
			WHERE e.content_hash = n.content_hash`,
			[],
			(row) => {
				const r = row as unknown as NoteWithEmbeddingRow;
				return {
					noteId: r.note_id,
					title: r.title,
					filePath: r.file_path,
					vector: blobToVector(r.vector),
				};
			}
		);
	}

	/**
	 * Get notes that need embedding generation.
	 */
	getNotesNeedingEmbedding(): Array<{ id: string; filePath: string; contentHash: string }> {
		const db = this.getDb();
		const result = db.exec(`
			SELECT n.id, n.file_path, n.content_hash
			FROM notes n
			LEFT JOIN embeddings e ON n.id = e.note_id
			WHERE e.note_id IS NULL
			   OR e.content_hash != n.content_hash
		`);

		if (result.length === 0) return [];

		return result[0].values.map((row) => ({
			id: row[0] as string,
			filePath: row[1] as string,
			contentHash: row[2] as string,
		}));
	}

	/**
	 * Get note embedding statistics.
	 */
	getNoteEmbeddingCounts(): { total: number; embedded: number; pending: number } {
		const db = this.getDb();

		const totalResult = db.exec("SELECT COUNT(*) FROM notes");
		const total = totalResult.length > 0 ? (totalResult[0].values[0][0] as number) : 0;

		const embeddedResult = db.exec(`
			SELECT COUNT(*)
			FROM notes n
			JOIN embeddings e ON n.id = e.note_id
			WHERE e.content_hash = n.content_hash
		`);
		const embedded = embeddedResult.length > 0 ? (embeddedResult[0].values[0][0] as number) : 0;

		return { total, embedded, pending: total - embedded };
	}

	/**
	 * Delete note embedding by note ID.
	 */
	deleteNoteEmbedding(noteId: string): void {
		runQuery(this.getDb(), "DELETE FROM embeddings WHERE note_id = ?", [noteId]);
	}

	/**
	 * Batch delete note embeddings by note IDs.
	 */
	deleteNoteEmbeddings(noteIds: string[]): void {
		if (noteIds.length === 0) return;
		runBatchedQuery(
			this.getDb(),
			"DELETE FROM embeddings WHERE note_id IN ({placeholders})",
			noteIds
		);
	}

	/**
	 * Check if any note embeddings exist.
	 */
	hasAnyNoteEmbeddings(): boolean {
		const db = this.getDb();
		const result = db.exec("SELECT COUNT(*) FROM embeddings");
		return result.length > 0 && (result[0].values[0][0] as number) > 0;
	}

	// ========================================
	// Chunk-level embeddings
	// ========================================

	/**
	 * Upsert a chunk-level embedding.
	 */
	upsertChunkEmbedding(embedding: ChunkEmbedding): void {
		const db = this.getDb();
		const vectorBlob = vectorToBlob(embedding.vector);
		const exists = rowExists(db, "SELECT chunk_id FROM chunk_embeddings WHERE chunk_id = ?", [embedding.chunkId]);

		if (exists) {
			runQuery(
				db,
				`UPDATE chunk_embeddings SET vector = ?, content_hash = ? WHERE chunk_id = ?`,
				[vectorBlob, embedding.contentHash, embedding.chunkId]
			);
		} else {
			runQuery(
				db,
				`INSERT INTO chunk_embeddings (chunk_id, vector, content_hash) VALUES (?, ?, ?)`,
				[embedding.chunkId, vectorBlob, embedding.contentHash]
			);
		}
	}

	/**
	 * Get chunk embedding by chunk ID.
	 */
	getChunkEmbedding(chunkId: string): ChunkEmbedding | null {
		return querySingle(
			this.getDb(),
			"SELECT * FROM chunk_embeddings WHERE chunk_id = ?",
			[chunkId],
			(row) => {
				const r = row as unknown as ChunkEmbeddingRow;
				return {
					chunkId: r.chunk_id,
					vector: blobToVector(r.vector),
					contentHash: r.content_hash,
				};
			}
		);
	}

	/**
	 * Delete chunk embedding by chunk ID.
	 */
	deleteChunkEmbedding(chunkId: string): void {
		runQuery(this.getDb(), "DELETE FROM chunk_embeddings WHERE chunk_id = ?", [chunkId]);
	}

	/**
	 * Delete chunk embeddings by note ID (via chunks table).
	 */
	deleteChunkEmbeddingsByNoteId(noteId: string): void {
		runQuery(
			this.getDb(),
			`DELETE FROM chunk_embeddings
			WHERE chunk_id IN (SELECT id FROM note_chunks WHERE note_id = ?)`,
			[noteId]
		);
	}

	/**
	 * Get all chunk embeddings with note info for semantic search.
	 * Only returns chunks where content_hash matches (embedding is valid).
	 */
	getAllChunkEmbeddingsWithChunks(): ChunkWithNote[] {
		const db = this.getDb();
		const result = db.exec(`
			SELECT
				ce.chunk_id,
				ce.vector,
				nc.note_id,
				nc.heading,
				nc.heading_level,
				nc.content,
				nc.start_line,
				n.title as note_title,
				n.file_path
			FROM chunk_embeddings ce
			JOIN note_chunks nc ON ce.chunk_id = nc.id AND ce.content_hash = nc.content_hash
			JOIN notes n ON nc.note_id = n.id
		`);

		if (result.length === 0) return [];

		const columns = result[0].columns;
		return result[0].values.map((row) => {
			const obj = {} as ChunkWithNoteRow;
			columns.forEach((col, i) => {
				(obj as Record<string, unknown>)[col] = row[i];
			});
			return {
				chunkId: obj.chunk_id,
				noteId: obj.note_id,
				noteTitle: obj.note_title,
				filePath: obj.file_path,
				heading: obj.heading,
				headingLevel: obj.heading_level,
				content: obj.content,
				startLine: obj.start_line,
				vector: blobToVector(obj.vector),
			};
		});
	}

	/**
	 * Check if any chunk embeddings exist.
	 */
	hasAnyChunkEmbeddings(): boolean {
		const db = this.getDb();
		const result = db.exec("SELECT COUNT(*) as count FROM chunk_embeddings");
		return result.length > 0 && (result[0].values[0][0] as number) > 0;
	}

	/**
	 * Get chunk embedding statistics.
	 */
	getChunkEmbeddingCounts(): { totalChunks: number; embedded: number; pending: number } {
		const db = this.getDb();

		const totalResult = db.exec("SELECT COUNT(*) FROM note_chunks");
		const totalChunks = totalResult.length > 0 ? (totalResult[0].values[0][0] as number) : 0;

		const embeddedResult = db.exec(`
			SELECT COUNT(*) FROM chunk_embeddings ce
			JOIN note_chunks nc ON ce.chunk_id = nc.id AND ce.content_hash = nc.content_hash
		`);
		const embedded = embeddedResult.length > 0 ? (embeddedResult[0].values[0][0] as number) : 0;

		return { totalChunks, embedded, pending: totalChunks - embedded };
	}

	// ========================================
	// Combined utilities
	// ========================================

	/**
	 * Check if embeddings exist (note or chunk level).
	 */
	hasAnyEmbeddings(): boolean {
		return this.hasAnyChunkEmbeddings() || this.hasAnyNoteEmbeddings();
	}

	/**
	 * Get combined embedding counts (prefers chunk embeddings if available).
	 */
	getEmbeddingCounts(): { total: number; embedded: number; pending: number } {
		const chunkCounts = this.getChunkEmbeddingCounts();

		if (chunkCounts.totalChunks > 0) {
			return {
				total: chunkCounts.totalChunks,
				embedded: chunkCounts.embedded,
				pending: chunkCounts.pending,
			};
		}

		return this.getNoteEmbeddingCounts();
	}
}
