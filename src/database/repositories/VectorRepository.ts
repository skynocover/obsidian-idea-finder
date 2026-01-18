import type { Database } from "sql.js";
import type { ChunkEmbedding, ChunkWithNote } from "../../types";
import type { ChunkEmbeddingRow, ChunkWithNoteRow } from "../sql-types";
import { vectorToBlob, blobToVector } from "../../utils/vector";
import { runQuery, queryMany, rowExists } from "../utils";

/**
 * Repository for chunk-level vector embeddings.
 */
export class VectorRepository {
	constructor(private getDb: () => Database) {}

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
		const db = this.getDb();
		const stmt = db.prepare("SELECT * FROM chunk_embeddings WHERE chunk_id = ?");
		stmt.bind([chunkId]);

		let result: ChunkEmbedding | null = null;
		if (stmt.step()) {
			const row = stmt.getAsObject() as unknown as ChunkEmbeddingRow;
			result = {
				chunkId: row.chunk_id,
				vector: blobToVector(row.vector),
				contentHash: row.content_hash,
			};
		}
		stmt.free();
		return result;
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
	 * Get chunk embeddings for a specific note.
	 */
	getChunkEmbeddingsForNote(noteId: string): ChunkWithNote[] {
		return queryMany(
			this.getDb(),
			`SELECT
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
			WHERE nc.note_id = ?`,
			[noteId],
			(row) => {
				const obj = row as unknown as ChunkWithNoteRow;
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
			}
		);
	}

	/**
	 * Check if any chunk embeddings exist.
	 */
	hasAnyEmbeddings(): boolean {
		const db = this.getDb();
		const result = db.exec("SELECT COUNT(*) as count FROM chunk_embeddings");
		return result.length > 0 && (result[0].values[0][0] as number) > 0;
	}

	/**
	 * Check if a note has any chunk embeddings.
	 */
	hasEmbeddingsForNote(noteId: string): boolean {
		const db = this.getDb();
		const result = db.exec(`
			SELECT COUNT(*) FROM chunk_embeddings ce
			JOIN note_chunks nc ON ce.chunk_id = nc.id AND ce.content_hash = nc.content_hash
			WHERE nc.note_id = '${noteId}'
		`);
		return result.length > 0 && (result[0].values[0][0] as number) > 0;
	}

	/**
	 * Get chunk embedding statistics.
	 */
	getEmbeddingCounts(): { total: number; embedded: number; pending: number } {
		const db = this.getDb();

		const totalResult = db.exec("SELECT COUNT(*) FROM note_chunks");
		const total = totalResult.length > 0 ? (totalResult[0].values[0][0] as number) : 0;

		const embeddedResult = db.exec(`
			SELECT COUNT(*) FROM chunk_embeddings ce
			JOIN note_chunks nc ON ce.chunk_id = nc.id AND ce.content_hash = nc.content_hash
		`);
		const embedded = embeddedResult.length > 0 ? (embeddedResult[0].values[0][0] as number) : 0;

		return { total, embedded, pending: total - embedded };
	}

	/**
	 * Get note-level embedding statistics.
	 * Returns count of notes that have pending chunk embeddings.
	 */
	getNoteEmbeddingCounts(): { total: number; embedded: number; pending: number } {
		const db = this.getDb();

		// Total notes that have chunks
		const totalResult = db.exec("SELECT COUNT(DISTINCT note_id) FROM note_chunks");
		const total = totalResult.length > 0 ? (totalResult[0].values[0][0] as number) : 0;

		// Notes where ALL chunks have valid embeddings
		const embeddedResult = db.exec(`
			SELECT COUNT(*) FROM (
				SELECT nc.note_id
				FROM note_chunks nc
				GROUP BY nc.note_id
				HAVING COUNT(*) = (
					SELECT COUNT(*) FROM chunk_embeddings ce
					JOIN note_chunks nc2 ON ce.chunk_id = nc2.id AND ce.content_hash = nc2.content_hash
					WHERE nc2.note_id = nc.note_id
				)
			)
		`);
		const embedded = embeddedResult.length > 0 ? (embeddedResult[0].values[0][0] as number) : 0;

		return { total, embedded, pending: total - embedded };
	}
}
