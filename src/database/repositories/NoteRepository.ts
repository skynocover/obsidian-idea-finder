import type { Database } from "sql.js";
import type { Note } from "../../types";
import type { NoteRow } from "../sql-types";
import { runQuery, querySingle, runBatchedQuery, queryBatched, rowExists } from "../utils";

export class NoteRepository {
	constructor(private getDb: () => Database) {}

	upsertNote(note: Omit<Note, "indexedAt">): void {
		const db = this.getDb();
		const exists = rowExists(db, "SELECT id FROM notes WHERE id = ?", [note.id]);

		if (exists) {
			runQuery(
				db,
				`UPDATE notes SET
					file_path = ?,
					title = ?,
					content_hash = ?,
					indexed_at = strftime('%s', 'now')
				WHERE id = ?`,
				[note.filePath, note.title, note.contentHash, note.id]
			);
		} else {
			runQuery(
				db,
				`INSERT INTO notes (id, file_path, title, content_hash, indexed_at)
				VALUES (?, ?, ?, ?, strftime('%s', 'now'))`,
				[note.id, note.filePath, note.title, note.contentHash]
			);
		}
	}

	deleteNote(id: string): void {
		runQuery(this.getDb(), "DELETE FROM notes WHERE id = ?", [id]);
	}

	deleteNoteByPath(filePath: string): void {
		runQuery(this.getDb(), "DELETE FROM notes WHERE file_path = ?", [filePath]);
	}

	/**
	 * Update only the file path for a note (preserves ID and embedding).
	 * Used for rename/move operations.
	 */
	updateFilePath(oldPath: string, newPath: string): boolean {
		const db = this.getDb();
		runQuery(
			db,
			`UPDATE notes SET
				file_path = ?,
				indexed_at = strftime('%s', 'now')
			WHERE file_path = ?`,
			[newPath, oldPath]
		);
		return db.getRowsModified() > 0;
	}

	/**
	 * Batch delete notes by file paths.
	 */
	deleteNotesByPaths(filePaths: string[]): void {
		if (filePaths.length === 0) return;
		runBatchedQuery(
			this.getDb(),
			"DELETE FROM notes WHERE file_path IN ({placeholders})",
			filePaths
		);
	}

	/**
	 * Get note IDs by file paths (for batch operations).
	 */
	getNoteIdsByPaths(filePaths: string[]): Map<string, string> {
		if (filePaths.length === 0) return new Map();

		const rows = queryBatched(
			this.getDb(),
			"SELECT id, file_path FROM notes WHERE file_path IN ({placeholders})",
			filePaths,
			(stmt) => stmt.getAsObject() as Pick<NoteRow, "id" | "file_path">
		);

		return new Map(rows.map((row) => [row.file_path, row.id]));
	}

	getAllNotes(): Note[] {
		const db = this.getDb();
		const result = db.exec("SELECT * FROM notes");
		if (result.length === 0) return [];

		const columns = result[0].columns;
		return result[0].values.map((row) => this.mapRowToNote(columns, row));
	}

	getNoteById(id: string): Note | null {
		return querySingle(
			this.getDb(),
			"SELECT * FROM notes WHERE id = ?",
			[id],
			(row) => this.mapRowFromObject(row as unknown as NoteRow)
		);
	}

	getNoteByPath(filePath: string): Note | null {
		return querySingle(
			this.getDb(),
			"SELECT * FROM notes WHERE file_path = ?",
			[filePath],
			(row) => this.mapRowFromObject(row as unknown as NoteRow)
		);
	}

	getAllFilePaths(): string[] {
		const db = this.getDb();
		const result = db.exec("SELECT file_path FROM notes");
		if (result.length === 0) return [];

		return result[0].values.map((row) => row[0] as string);
	}

	getNotesCount(): number {
		const db = this.getDb();
		const result = db.exec("SELECT COUNT(*) as count FROM notes");
		if (result.length === 0) return 0;
		return result[0].values[0][0] as number;
	}

	private mapRowToNote(columns: string[], row: unknown[]): Note {
		const obj = {} as NoteRow;
		columns.forEach((col, i) => {
			(obj as Record<string, unknown>)[col] = row[i];
		});
		return this.mapRowFromObject(obj);
	}

	private mapRowFromObject(obj: NoteRow): Note {
		return {
			id: obj.id,
			filePath: obj.file_path,
			title: obj.title,
			contentHash: obj.content_hash,
			indexedAt: obj.indexed_at,
		};
	}
}
