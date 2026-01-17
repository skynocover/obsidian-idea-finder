/**
 * Database utility functions for common operations.
 */
import type { Database, Statement } from "sql.js";
import { DB_BATCH_SIZE } from "../config/constants";

/**
 * Process items in batches.
 * Generic utility to avoid repeated batch loop patterns.
 *
 * @param items - Array of items to process
 * @param batchSize - Maximum items per batch
 * @param processor - Callback to process each batch
 */
export function processBatches<T>(
	items: T[],
	batchSize: number,
	processor: (batch: T[]) => void
): void {
	for (let i = 0; i < items.length; i += batchSize) {
		const batch = items.slice(i, i + batchSize);
		processor(batch);
	}
}

/**
 * Execute a batch DELETE or UPDATE query with IN clause.
 * Automatically handles batching and placeholder generation.
 *
 * @param db - Database instance
 * @param queryTemplate - SQL template with {placeholders} for IN clause
 * @param items - Array of values for the IN clause
 * @param batchSize - Optional batch size (default: DB_BATCH_SIZE)
 *
 * @example
 * // DELETE example
 * runBatchedQuery(db, "DELETE FROM notes WHERE file_path IN ({placeholders})", filePaths);
 *
 * // UPDATE example
 * runBatchedQuery(db, "UPDATE links SET to_note_id = NULL WHERE to_note_id IN ({placeholders})", noteIds);
 */
export function runBatchedQuery(
	db: Database,
	queryTemplate: string,
	items: unknown[],
	batchSize: number = DB_BATCH_SIZE
): void {
	if (items.length === 0) return;

	processBatches(items, batchSize, (batch) => {
		const placeholders = batch.map(() => "?").join(",");
		const query = queryTemplate.replace("{placeholders}", placeholders);
		const stmt = db.prepare(query);
		stmt.run(batch);
		stmt.free();
	});
}

/**
 * Execute a batch SELECT query with IN clause and return results.
 * Automatically handles batching and placeholder generation.
 *
 * @param db - Database instance
 * @param queryTemplate - SQL template with {placeholders} for IN clause
 * @param items - Array of values for the IN clause
 * @param mapper - Function to map each row to result type
 * @param batchSize - Optional batch size (default: DB_BATCH_SIZE)
 * @returns Array of mapped results from all batches
 *
 * @example
 * const results = queryBatched(
 *   db,
 *   "SELECT id, file_path FROM notes WHERE file_path IN ({placeholders})",
 *   filePaths,
 *   (stmt) => stmt.getAsObject() as { id: string; file_path: string }
 * );
 */
export function queryBatched<T>(
	db: Database,
	queryTemplate: string,
	items: unknown[],
	mapper: (stmt: Statement) => T,
	batchSize: number = DB_BATCH_SIZE
): T[] {
	if (items.length === 0) return [];

	const results: T[] = [];

	processBatches(items, batchSize, (batch) => {
		const placeholders = batch.map(() => "?").join(",");
		const query = queryTemplate.replace("{placeholders}", placeholders);
		const stmt = db.prepare(query);
		stmt.bind(batch);

		while (stmt.step()) {
			results.push(mapper(stmt));
		}
		stmt.free();
	});

	return results;
}

/**
 * Execute a prepared statement with automatic cleanup.
 * Ensures stmt.free() is always called, even if an error occurs.
 *
 * @param db - Database instance
 * @param query - SQL query string
 * @param params - Query parameters
 * @param action - Callback to execute with the statement
 * @returns Result from the action callback
 *
 * @example
 * const note = withStatement(db, "SELECT * FROM notes WHERE id = ?", [noteId], (stmt) => {
 *   if (stmt.step()) {
 *     return stmt.getAsObject() as NoteRow;
 *   }
 *   return null;
 * });
 */
export function withStatement<T>(
	db: Database,
	query: string,
	params: unknown[],
	action: (stmt: Statement) => T
): T {
	const stmt = db.prepare(query);
	try {
		stmt.bind(params);
		return action(stmt);
	} finally {
		stmt.free();
	}
}

/**
 * Run a simple query (INSERT/UPDATE/DELETE) with automatic cleanup.
 *
 * @param db - Database instance
 * @param query - SQL query string
 * @param params - Query parameters
 *
 * @example
 * runQuery(db, "DELETE FROM notes WHERE id = ?", [noteId]);
 */
export function runQuery(db: Database, query: string, params: unknown[]): void {
	const stmt = db.prepare(query);
	try {
		stmt.run(params);
	} finally {
		stmt.free();
	}
}

/**
 * Query single row with automatic cleanup.
 * Returns null if no row found.
 *
 * @param db - Database instance
 * @param query - SQL query string
 * @param params - Query parameters
 * @param mapper - Function to map row to result type
 * @returns Mapped result or null
 *
 * @example
 * const note = querySingle(db, "SELECT * FROM notes WHERE id = ?", [noteId], (row) => ({
 *   id: row.id,
 *   filePath: row.file_path,
 * }));
 */
export function querySingle<T>(
	db: Database,
	query: string,
	params: unknown[],
	mapper: (row: Record<string, unknown>) => T
): T | null {
	return withStatement(db, query, params, (stmt) => {
		if (stmt.step()) {
			return mapper(stmt.getAsObject() as Record<string, unknown>);
		}
		return null;
	});
}

/**
 * Query multiple rows with automatic cleanup.
 *
 * @param db - Database instance
 * @param query - SQL query string
 * @param params - Query parameters
 * @param mapper - Function to map each row to result type
 * @returns Array of mapped results
 *
 * @example
 * const chunks = queryMany(db, "SELECT * FROM note_chunks WHERE note_id = ?", [noteId], (row) => ({
 *   id: row.id,
 *   content: row.content,
 * }));
 */
export function queryMany<T>(
	db: Database,
	query: string,
	params: unknown[],
	mapper: (row: Record<string, unknown>) => T
): T[] {
	return withStatement(db, query, params, (stmt) => {
		const results: T[] = [];
		while (stmt.step()) {
			results.push(mapper(stmt.getAsObject() as Record<string, unknown>));
		}
		return results;
	});
}

/**
 * Check if a row exists with automatic cleanup.
 *
 * @param db - Database instance
 * @param query - SQL query string (should be a SELECT that may return rows)
 * @param params - Query parameters
 * @returns true if at least one row exists
 *
 * @example
 * const exists = rowExists(db, "SELECT 1 FROM notes WHERE id = ?", [noteId]);
 */
export function rowExists(db: Database, query: string, params: unknown[]): boolean {
	return withStatement(db, query, params, (stmt) => stmt.step());
}
