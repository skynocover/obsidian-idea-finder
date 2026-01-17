import type { Database } from "sql.js";
import type { Chunk } from "../../types";
import type { ChunkRow } from "../sql-types";
import { runQuery, querySingle, queryMany, rowExists } from "../utils";

export class ChunkRepository {
	constructor(private getDb: () => Database) {}

	/**
	 * Insert or update a chunk.
	 */
	upsertChunk(chunk: Chunk): void {
		const db = this.getDb();
		const exists = rowExists(db, "SELECT id FROM note_chunks WHERE id = ?", [chunk.id]);

		if (exists) {
			runQuery(
				db,
				`UPDATE note_chunks SET
					note_id = ?,
					heading = ?,
					heading_level = ?,
					content = ?,
					start_line = ?,
					content_hash = ?
				WHERE id = ?`,
				[
					chunk.noteId,
					chunk.heading,
					chunk.headingLevel,
					chunk.content,
					chunk.startLine,
					chunk.contentHash,
					chunk.id,
				]
			);
		} else {
			runQuery(
				db,
				`INSERT INTO note_chunks (id, note_id, heading, heading_level, content, start_line, content_hash)
				VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[
					chunk.id,
					chunk.noteId,
					chunk.heading,
					chunk.headingLevel,
					chunk.content,
					chunk.startLine,
					chunk.contentHash,
				]
			);
		}
	}

	/**
	 * Get all chunks for a note.
	 */
	getChunksByNoteId(noteId: string): Chunk[] {
		return queryMany(
			this.getDb(),
			"SELECT * FROM note_chunks WHERE note_id = ? ORDER BY start_line",
			[noteId],
			(row) => this.mapRowToChunk(row as unknown as ChunkRow)
		);
	}

	/**
	 * Get a chunk by ID.
	 */
	getChunkById(id: string): Chunk | null {
		return querySingle(
			this.getDb(),
			"SELECT * FROM note_chunks WHERE id = ?",
			[id],
			(row) => this.mapRowToChunk(row as unknown as ChunkRow)
		);
	}

	/**
	 * Delete all chunks for a note.
	 */
	deleteChunksByNoteId(noteId: string): void {
		runQuery(this.getDb(), "DELETE FROM note_chunks WHERE note_id = ?", [noteId]);
	}

	/**
	 * Delete a specific chunk.
	 */
	deleteChunk(id: string): void {
		runQuery(this.getDb(), "DELETE FROM note_chunks WHERE id = ?", [id]);
	}

	/**
	 * Get all chunks.
	 */
	getAllChunks(): Chunk[] {
		const db = this.getDb();
		const result = db.exec("SELECT * FROM note_chunks ORDER BY note_id, start_line");
		if (result.length === 0) return [];

		const columns = result[0].columns;
		return result[0].values.map((row) => {
			const obj: Record<string, unknown> = {};
			columns.forEach((col, i) => {
				obj[col] = row[i];
			});
			return this.mapRowToChunk(obj as unknown as ChunkRow);
		});
	}

	/**
	 * Get chunk count.
	 */
	getChunkCount(): number {
		const db = this.getDb();
		const result = db.exec("SELECT COUNT(*) as count FROM note_chunks");
		if (result.length === 0) return 0;
		return result[0].values[0][0] as number;
	}

	/**
	 * Get chunks that need embeddings (no embedding or hash mismatch).
	 */
	getChunksNeedingEmbeddings(): Chunk[] {
		const db = this.getDb();
		const result = db.exec(`
			SELECT nc.* FROM note_chunks nc
			LEFT JOIN chunk_embeddings ce ON nc.id = ce.chunk_id
			WHERE ce.chunk_id IS NULL OR ce.content_hash != nc.content_hash
			ORDER BY nc.note_id, nc.start_line
		`);
		if (result.length === 0) return [];

		const columns = result[0].columns;
		return result[0].values.map((row) => {
			const obj: Record<string, unknown> = {};
			columns.forEach((col, i) => {
				obj[col] = row[i];
			});
			return this.mapRowToChunk(obj as unknown as ChunkRow);
		});
	}

	private mapRowToChunk(row: ChunkRow): Chunk {
		return {
			id: row.id,
			noteId: row.note_id,
			heading: row.heading,
			headingLevel: row.heading_level,
			content: row.content,
			startLine: row.start_line,
			contentHash: row.content_hash,
		};
	}
}
