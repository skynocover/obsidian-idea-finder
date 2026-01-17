/**
 * Type definitions for SQL query results.
 * These map directly to database column names (snake_case).
 */

// ===== Notes Table =====

export interface NoteRow {
	id: string;
	file_path: string;
	title: string;
	content_hash: string;
	indexed_at: number;
}

// ===== Embeddings Table =====

export interface EmbeddingRow {
	note_id: string;
	vector: Uint8Array;
	content_hash: string;
}

// ===== Note Tags Table =====

export interface NoteTagRow {
	note_id: string;
	tag: string;
}

export interface TagCountRow {
	tag: string;
	count: number;
}

// ===== Links Table =====

export interface LinkRow {
	id: number;
	from_note_id: string;
	to_note_id: string | null;
	to_text: string;
}

// ===== Chunks Table =====

export interface ChunkRow {
	id: string;
	note_id: string;
	heading: string | null;
	heading_level: number | null;
	content: string;
	start_line: number;
	content_hash: string;
}

// ===== Chunk Embeddings Table =====

export interface ChunkEmbeddingRow {
	chunk_id: string;
	vector: Uint8Array;
	content_hash: string;
}

// ===== Join Query Results =====

export interface NoteWithEmbeddingRow {
	note_id: string;
	title: string;
	file_path: string;
	vector: Uint8Array;
}

export interface ChunkWithNoteRow {
	chunk_id: string;
	note_id: string;
	note_title: string;
	file_path: string;
	heading: string | null;
	heading_level: number | null;
	content: string;
	start_line: number;
	vector: Uint8Array;
}

// ===== Utility Types =====

/**
 * Helper to extract row type from sql.js statement.getAsObject()
 */
export type SqlValue = string | number | Uint8Array | null;

/**
 * Generic row object from sql.js
 */
export type SqlRow = Record<string, SqlValue>;
