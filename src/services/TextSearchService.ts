import MiniSearch from "minisearch";
import { type App } from "obsidian";
import type { NoteRepository } from "../database/repositories/NoteRepository";
import type { ChunkRepository } from "../database/repositories/ChunkRepository";
import { LRUCache } from "../utils/lru-cache";
import type { Logger } from "../utils/Logger";
import { SEARCH_CACHE_SIZE, SNIPPET_CONTEXT_LENGTH } from "../config/constants";

export interface SearchResult {
	chunkId: string;
	noteId: string;
	title: string;
	heading: string;
	filePath: string;
	score: number;
	snippet: string;
	startLine: number;
}

interface IndexedDocument {
	id: string;           // chunk ID
	noteId: string;       // note ID
	title: string;        // note title
	heading: string;      // chunk heading (empty string for no heading)
	content: string;      // chunk content
	filePath: string;
	startLine: number;
}

export class TextSearchService {
	private miniSearch: MiniSearch<IndexedDocument>;
	private noteRepo: NoteRepository;
	private chunkRepo: ChunkRepository;
	private app: App;
	private isInitialized = false;
	private searchCache: LRUCache<string, SearchResult[]>;
	private logger: Logger | null;

	constructor(
		noteRepo: NoteRepository,
		chunkRepo: ChunkRepository,
		app: App,
		logger: Logger | null = null
	) {
		this.noteRepo = noteRepo;
		this.chunkRepo = chunkRepo;
		this.app = app;
		this.logger = logger;
		this.searchCache = new LRUCache<string, SearchResult[]>(SEARCH_CACHE_SIZE);
		this.miniSearch = new MiniSearch<IndexedDocument>({
			fields: ["title", "heading", "content"],
			storeFields: ["noteId", "title", "heading", "filePath", "startLine"],
			searchOptions: {
				boost: { title: 2, heading: 1.5 },
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
	 * Initialize the search index from database (chunk-level).
	 */
	async initialize(): Promise<void> {
		if (this.isInitialized) return;

		this.logger?.info("TextSearch: Initializing chunk-level search index...");

		const chunks = this.chunkRepo.getAllChunks();
		const notes = this.noteRepo.getAllNotes();
		const noteMap = new Map(notes.map((n) => [n.id, n]));

		const documents: IndexedDocument[] = chunks.map((chunk) => {
			const note = noteMap.get(chunk.noteId);
			return {
				id: chunk.id,
				noteId: chunk.noteId,
				title: note?.title || "Untitled",
				heading: chunk.heading || "",
				content: chunk.content,
				filePath: note?.filePath || "",
				startLine: chunk.startLine,
			};
		});

		if (documents.length > 0) {
			this.miniSearch.addAll(documents);
		}

		this.isInitialized = true;
		this.logger?.info(`TextSearch: Indexed ${documents.length} chunks`);
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
	 * Search for chunks matching the query.
	 * Returns individual chunk results.
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
			boost: { title: 2, heading: 1.5 },
			prefix: true,
		};

		if (isEnglish) {
			// For English queries, increase fuzzy tolerance for better typo handling
			searchOptions.fuzzy = 0.25;
			searchOptions.combineWith = "OR";
		} else {
			// For CJK/mixed queries, use tighter fuzzy matching
			searchOptions.fuzzy = 0.2;
		}

		const results = this.miniSearch.search(query, searchOptions);

		const searchResults: SearchResult[] = [];
		for (const result of results) {
			const snippet = this.generateSnippetFromContent(
				result.content as string || "",
				query
			);
			searchResults.push({
				chunkId: result.id,
				noteId: result.noteId as string,
				title: result.title as string,
				heading: result.heading as string,
				filePath: result.filePath as string,
				score: result.score,
				snippet,
				startLine: result.startLine as number,
			});
		}

		// Store in cache
		this.searchCache.set(cacheKey, searchResults);

		return searchResults;
	}

	/**
	 * Add or update chunks for a note in the index.
	 * Call this when a note is indexed/updated.
	 */
	addOrUpdateNote(noteId: string, title: string, filePath: string): void {
		// First remove all existing chunks for this note
		this.removeAllForNote(noteId);

		// Get all chunks for the note from the database
		const chunks = this.chunkRepo.getChunksByNoteId(noteId);

		// Add each chunk to the index
		for (const chunk of chunks) {
			this.miniSearch.add({
				id: chunk.id,
				noteId: chunk.noteId,
				title,
				heading: chunk.heading || "",
				content: chunk.content,
				filePath,
				startLine: chunk.startLine,
			});
		}

		// Clear cache since index has changed
		this.searchCache.clear();
	}

	/**
	 * Remove all chunks for a note from the index.
	 */
	removeAllForNote(noteId: string): void {
		// Get all document IDs in the index that belong to this note
		const allDocs = this.miniSearch.search("", { prefix: false, fuzzy: false });

		// MiniSearch doesn't have a direct way to query by field,
		// so we need to iterate through all indexed chunks
		const chunks = this.chunkRepo.getChunksByNoteId(noteId);
		for (const chunk of chunks) {
			if (this.miniSearch.has(chunk.id)) {
				this.miniSearch.discard(chunk.id);
			}
		}

		// Clear cache since index has changed
		this.searchCache.clear();
	}

	/**
	 * Remove a specific chunk from the index.
	 */
	removeChunk(chunkId: string): void {
		if (this.miniSearch.has(chunkId)) {
			this.miniSearch.discard(chunkId);
		}
		this.searchCache.clear();
	}

	/**
	 * Rebuild the entire index from database.
	 */
	async rebuild(): Promise<void> {
		this.logger?.info("TextSearch: Rebuilding chunk-level index...");

		// Clear existing index and cache
		this.miniSearch.removeAll();
		this.searchCache.clear();

		// Re-add all chunks
		const chunks = this.chunkRepo.getAllChunks();
		const notes = this.noteRepo.getAllNotes();
		const noteMap = new Map(notes.map((n) => [n.id, n]));

		const documents: IndexedDocument[] = chunks.map((chunk) => {
			const note = noteMap.get(chunk.noteId);
			return {
				id: chunk.id,
				noteId: chunk.noteId,
				title: note?.title || "Untitled",
				heading: chunk.heading || "",
				content: chunk.content,
				filePath: note?.filePath || "",
				startLine: chunk.startLine,
			};
		});

		if (documents.length > 0) {
			this.miniSearch.addAll(documents);
		}

		this.logger?.info(`TextSearch: Rebuilt index with ${documents.length} chunks`);
	}

	/**
	 * Generate a snippet with highlighted matches from chunk content.
	 */
	private generateSnippetFromContent(content: string, query: string): string {
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
