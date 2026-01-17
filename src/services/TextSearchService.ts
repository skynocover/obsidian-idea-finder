import MiniSearch from "minisearch";
import { type App } from "obsidian";
import type { NoteRepository } from "../database/repositories/NoteRepository";
import { LRUCache } from "../utils/lru-cache";
import { readFileContent } from "../utils/file";
import type { Logger } from "../utils/Logger";
import { SEARCH_CACHE_SIZE, SNIPPET_CONTEXT_LENGTH } from "../config/constants";

export interface SearchResult {
	noteId: string;
	title: string;
	filePath: string;
	score: number;
	snippet: string;
}

interface IndexedDocument {
	id: string;
	title: string;
	content: string;
	filePath: string;
}

export class TextSearchService {
	private miniSearch: MiniSearch<IndexedDocument>;
	private noteRepo: NoteRepository;
	private app: App;
	private isInitialized = false;
	private searchCache: LRUCache<string, SearchResult[]>;
	private logger: Logger | null;

	constructor(noteRepo: NoteRepository, app: App, logger: Logger | null = null) {
		this.noteRepo = noteRepo;
		this.app = app;
		this.logger = logger;
		this.searchCache = new LRUCache<string, SearchResult[]>(SEARCH_CACHE_SIZE);
		this.miniSearch = new MiniSearch<IndexedDocument>({
			fields: ["title", "content"],
			storeFields: ["title", "filePath"],
			searchOptions: {
				boost: { title: 2 },
				fuzzy: 0.2,
				prefix: true,
			},
			// Custom tokenizer for better CJK (Chinese, Japanese, Korean) support
			tokenize: (text) => {
				// Split on whitespace, punctuation, and CJK characters
				return text
					.toLowerCase()
					.split(/[\s\p{P}]+/u)
					.filter((token) => token.length > 0);
			},
		});
	}

	/**
	 * Initialize the search index from database.
	 */
	async initialize(): Promise<void> {
		if (this.isInitialized) return;

		this.logger?.info("TextSearch: Initializing search index...");

		const notes = this.noteRepo.getAllNotes();
		const documents: IndexedDocument[] = [];

		for (const note of notes) {
			const content = await readFileContent(this.app, note.filePath);
			if (content !== null) {
				documents.push({
					id: note.id,
					title: note.title,
					content,
					filePath: note.filePath,
				});
			}
		}

		if (documents.length > 0) {
			this.miniSearch.addAll(documents);
		}

		this.isInitialized = true;
		this.logger?.info(`TextSearch: Indexed ${documents.length} documents`);
	}

	/**
	 * Check if a query is primarily English/Latin characters.
	 */
	private isEnglishQuery(query: string): boolean {
		// Count Latin letters vs total non-whitespace characters
		const latinChars = (query.match(/[a-zA-Z]/g) || []).length;
		const nonSpaceChars = query.replace(/\s/g, "").length;
		return nonSpaceChars > 0 && latinChars / nonSpaceChars >= 0.5;
	}

	/**
	 * Search for notes matching the query.
	 * Applies enhanced fuzzy matching for English queries.
	 * Uses LRU cache to avoid redundant searches.
	 */
	async search(query: string, limit: number = 20): Promise<SearchResult[]> {
		if (!query.trim()) return [];

		// Check cache first
		const cacheKey = `${query}:${limit}`;
		const cached = this.searchCache.get(cacheKey);
		if (cached) {
			return cached;
		}

		// Determine search options based on query language
		const isEnglish = this.isEnglishQuery(query);
		const searchOptions: Record<string, unknown> = {
			limit,
			boost: { title: 2 },
			prefix: true,
		};

		if (isEnglish) {
			// For English queries, increase fuzzy tolerance for better typo handling
			searchOptions.fuzzy = 0.25;
			// For short English words (< 4 chars), use exact prefix matching
			// For longer words, allow more fuzzy variations
			searchOptions.combineWith = "OR";
		} else {
			// For CJK/mixed queries, use tighter fuzzy matching
			searchOptions.fuzzy = 0.2;
		}

		const results = this.miniSearch.search(query, searchOptions);

		const searchResults: SearchResult[] = [];
		for (const result of results) {
			const snippet = await this.generateSnippet(result.filePath as string, query);
			searchResults.push({
				noteId: result.id,
				title: result.title as string,
				filePath: result.filePath as string,
				score: result.score,
				snippet,
			});
		}

		// Store in cache
		this.searchCache.set(cacheKey, searchResults);

		return searchResults;
	}

	/**
	 * Add or update a document in the index.
	 * Clears the search cache since results may have changed.
	 */
	addOrUpdate(noteId: string, title: string, content: string, filePath: string): void {
		// Remove existing document if present
		if (this.miniSearch.has(noteId)) {
			this.miniSearch.discard(noteId);
		}

		// Add the document
		this.miniSearch.add({
			id: noteId,
			title,
			content,
			filePath,
		});

		// Clear cache since index has changed
		this.searchCache.clear();
	}

	/**
	 * Remove a document from the index.
	 * Clears the search cache since results may have changed.
	 */
	remove(noteId: string): void {
		if (this.miniSearch.has(noteId)) {
			this.miniSearch.discard(noteId);
		}

		// Clear cache since index has changed
		this.searchCache.clear();
	}

	/**
	 * Rebuild the entire index from database.
	 * Clears the search cache.
	 */
	async rebuild(): Promise<void> {
		this.logger?.info("TextSearch: Rebuilding index...");

		// Clear existing index and cache
		this.miniSearch.removeAll();
		this.searchCache.clear();

		// Re-add all documents
		const notes = this.noteRepo.getAllNotes();
		const documents: IndexedDocument[] = [];

		for (const note of notes) {
			const content = await readFileContent(this.app, note.filePath);
			if (content !== null) {
				documents.push({
					id: note.id,
					title: note.title,
					content,
					filePath: note.filePath,
				});
			}
		}

		if (documents.length > 0) {
			this.miniSearch.addAll(documents);
		}

		this.logger?.info(`TextSearch: Rebuilt index with ${documents.length} documents`);
	}

	/**
	 * Generate a snippet with highlighted matches.
	 * Optimized to use a single pre-compiled regex for all terms.
	 */
	private async generateSnippet(filePath: string, query: string): Promise<string> {
		const content = await readFileContent(this.app, filePath);
		if (!content) return "";

		const contentLower = content.toLowerCase();

		// Filter out empty terms and escape for regex
		const queryTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
		if (queryTerms.length === 0) {
			return content.slice(0, 150).trim() + (content.length > 150 ? "..." : "");
		}

		// Pre-compile a single regex pattern for all terms
		const escapedTerms = queryTerms.map((t) => this.escapeRegex(t));
		const combinedPattern = new RegExp(`(${escapedTerms.join("|")})`, "gi");

		// Find the first match using the combined pattern
		const firstMatch = combinedPattern.exec(contentLower);
		const bestIndex = firstMatch ? firstMatch.index : -1;

		if (bestIndex === -1) {
			// No match found, return beginning of content
			return content.slice(0, 150).trim() + (content.length > 150 ? "..." : "");
		}

		// Extract context around the match
		const snippetStart = Math.max(0, bestIndex - 50);
		const snippetEnd = Math.min(content.length, bestIndex + SNIPPET_CONTEXT_LENGTH);

		let snippet = content.slice(snippetStart, snippetEnd);

		// Add ellipsis if not at start/end
		if (snippetStart > 0) snippet = "..." + snippet;
		if (snippetEnd < content.length) snippet = snippet + "...";

		// Highlight all matches in a single pass using the same pattern
		// Reset lastIndex since we're using 'g' flag
		combinedPattern.lastIndex = 0;
		snippet = snippet.replace(combinedPattern, "<mark>$1</mark>");

		return snippet.trim();
	}

	private escapeRegex(str: string): string {
		return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}

	getDocumentCount(): number {
		return this.miniSearch.documentCount;
	}
}
