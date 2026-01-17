/**
 * Centralized constants for the Idea Finder plugin.
 * Avoids magic numbers scattered across the codebase.
 */

// ========================================
// API Configuration
// ========================================

/** Jina AI embeddings API endpoint */
export const JINA_API_URL = "https://api.jina.ai/v1/embeddings";

/** Jina AI embedding model name */
export const JINA_MODEL = "jina-embeddings-v3";

/** Batch size for API calls (embeddings) */
export const API_BATCH_SIZE = 10;

/** Maximum text length for embedding (truncate longer texts) */
export const MAX_TEXT_LENGTH = 8000;

/** Random jitter (0-1000ms) added to retry delays */
export const API_JITTER_MS = 1000;

// ========================================
// Database Configuration
// ========================================

/** Batch size for SQL IN clauses (prevent SQLite limitations) */
export const DB_BATCH_SIZE = 100;

// ========================================
// Search Configuration
// ========================================

/** Default number of search results to return */
export const DEFAULT_SEARCH_LIMIT = 10;

/** Default minimum similarity threshold (0-1) for semantic search */
export const DEFAULT_MIN_SIMILARITY = 0.3;

/** LRU cache size for search results */
export const SEARCH_CACHE_SIZE = 20;

/** Number of characters to show in search snippets (before/after match) */
export const SNIPPET_CONTEXT_LENGTH = 100;

// ========================================
// UI Configuration
// ========================================

/** Number of similar notes to show in sidebar */
export const SIMILAR_NOTES_LIMIT = 10;

/** Number of recent queries to show in search history */
export const RECENT_QUERIES_LIMIT = 10;

/** Number of notes to show in "all notes" list */
export const ALL_NOTES_LIMIT = 100;
