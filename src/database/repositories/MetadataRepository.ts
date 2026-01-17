import type { Database } from "sql.js";
import type { NoteTagRow, LinkRow } from "../sql-types";
import { runQuery, queryMany, queryBatched } from "../utils";

/**
 * Link interface for wiki-style links between notes.
 */
export interface Link {
	id: number;
	fromNoteId: string;
	toNoteId: string | null;
	toText: string;
}

/**
 * Unified repository for note metadata (links and tags).
 */
export class MetadataRepository {
	constructor(private getDb: () => Database) {}

	// ========================================
	// Tags
	// ========================================

	/**
	 * Set tags for a note (replaces existing tags).
	 */
	setTagsForNote(noteId: string, tags: string[]): void {
		const db = this.getDb();

		// Delete existing tags
		runQuery(db, "DELETE FROM note_tags WHERE note_id = ?", [noteId]);

		// Insert new tags
		if (tags.length > 0) {
			const stmt = db.prepare(
				"INSERT OR IGNORE INTO note_tags (note_id, tag) VALUES (?, ?)"
			);
			try {
				for (const tag of tags) {
					stmt.run([noteId, tag]);
				}
			} finally {
				stmt.free();
			}
		}
	}

	/**
	 * Get tags for a note.
	 */
	getTagsForNote(noteId: string): string[] {
		return queryMany(
			this.getDb(),
			"SELECT tag FROM note_tags WHERE note_id = ?",
			[noteId],
			(row) => (row as Pick<NoteTagRow, "tag">).tag
		);
	}

	/**
	 * Get all unique tags in the database.
	 */
	getAllTags(): string[] {
		const db = this.getDb();
		const result = db.exec("SELECT DISTINCT tag FROM note_tags ORDER BY tag");
		if (result.length === 0) return [];

		return result[0].values.map((row) => row[0] as string);
	}

	/**
	 * Get note IDs that have a specific tag.
	 */
	getNoteIdsByTag(tag: string): string[] {
		return queryMany(
			this.getDb(),
			"SELECT note_id FROM note_tags WHERE tag = ?",
			[tag],
			(row) => (row as Pick<NoteTagRow, "note_id">).note_id
		);
	}

	/**
	 * Delete all tags for a note.
	 */
	deleteTagsForNote(noteId: string): void {
		runQuery(this.getDb(), "DELETE FROM note_tags WHERE note_id = ?", [noteId]);
	}

	/**
	 * Get tag counts (how many notes have each tag).
	 */
	getTagCounts(): Array<{ tag: string; count: number }> {
		const db = this.getDb();
		const result = db.exec(
			"SELECT tag, COUNT(*) as count FROM note_tags GROUP BY tag ORDER BY count DESC"
		);
		if (result.length === 0) return [];

		return result[0].values.map((row) => ({
			tag: row[0] as string,
			count: row[1] as number,
		}));
	}

	// ========================================
	// Links
	// ========================================

	/**
	 * Set links for a note (replaces existing links).
	 */
	setLinksForNote(
		fromNoteId: string,
		links: Array<{ toText: string; toNoteId: string | null }>
	): void {
		const db = this.getDb();

		// Delete existing links from this note
		runQuery(db, "DELETE FROM links WHERE from_note_id = ?", [fromNoteId]);

		// Insert new links
		if (links.length > 0) {
			const stmt = db.prepare(
				"INSERT INTO links (from_note_id, to_note_id, to_text) VALUES (?, ?, ?)"
			);
			try {
				for (const link of links) {
					stmt.run([fromNoteId, link.toNoteId, link.toText]);
				}
			} finally {
				stmt.free();
			}
		}
	}

	/**
	 * Get all links from a note.
	 */
	getLinksFromNote(fromNoteId: string): Link[] {
		return queryMany(
			this.getDb(),
			"SELECT id, from_note_id, to_note_id, to_text FROM links WHERE from_note_id = ?",
			[fromNoteId],
			(row) => this.mapRowToLink(row as unknown as LinkRow)
		);
	}

	/**
	 * Get all backlinks (links pointing to a note).
	 */
	getBacklinksToNote(toNoteId: string): Link[] {
		return queryMany(
			this.getDb(),
			"SELECT id, from_note_id, to_note_id, to_text FROM links WHERE to_note_id = ?",
			[toNoteId],
			(row) => this.mapRowToLink(row as unknown as LinkRow)
		);
	}

	/**
	 * Get backlink count for a note.
	 */
	getBacklinkCount(noteId: string): number {
		const db = this.getDb();
		const result = db.exec(
			`SELECT COUNT(*) as count FROM links WHERE to_note_id = '${noteId.replace(/'/g, "''")}'`
		);
		return result.length > 0 ? (result[0].values[0][0] as number) : 0;
	}

	/**
	 * Get backlink counts for multiple notes in a single query.
	 */
	getBacklinkCounts(noteIds: string[]): Map<string, number> {
		if (noteIds.length === 0) return new Map();

		const result = new Map<string, number>();

		// Initialize all to 0
		for (const id of noteIds) {
			result.set(id, 0);
		}

		const rows = queryBatched(
			this.getDb(),
			"SELECT to_note_id, COUNT(*) as count FROM links WHERE to_note_id IN ({placeholders}) GROUP BY to_note_id",
			noteIds,
			(stmt) => stmt.getAsObject() as { to_note_id: string; count: number }
		);

		for (const row of rows) {
			result.set(row.to_note_id, row.count);
		}

		return result;
	}

	/**
	 * Delete all links from a note.
	 */
	deleteLinksFromNote(noteId: string): void {
		runQuery(this.getDb(), "DELETE FROM links WHERE from_note_id = ?", [noteId]);
	}

	/**
	 * Get all unique link targets (to_text) across all notes.
	 */
	getAllLinkTargets(): string[] {
		const db = this.getDb();
		const result = db.exec("SELECT DISTINCT to_text FROM links ORDER BY to_text");
		if (result.length === 0) return [];

		return result[0].values.map((row) => row[0] as string);
	}

	/**
	 * Resolve unresolved links after a new note is added.
	 */
	resolveLinksToNote(noteId: string, notePath: string): void {
		// Extract filename without extension for matching
		const fileName = notePath.replace(/\.md$/, "").split("/").pop() || "";

		runQuery(
			this.getDb(),
			"UPDATE links SET to_note_id = ? WHERE to_note_id IS NULL AND to_text = ?",
			[noteId, fileName]
		);
	}

	// ========================================
	// Combined utilities
	// ========================================

	/**
	 * Delete all metadata for a note (tags and links).
	 */
	deleteAllForNote(noteId: string): void {
		this.deleteTagsForNote(noteId);
		this.deleteLinksFromNote(noteId);
	}

	private mapRowToLink(row: LinkRow): Link {
		return {
			id: row.id,
			fromNoteId: row.from_note_id,
			toNoteId: row.to_note_id,
			toText: row.to_text,
		};
	}
}
