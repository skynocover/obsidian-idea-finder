import { App, SuggestModal, TFile } from "obsidian";
import type { TextSearchService, SearchResult } from "../services/TextSearchService";
import type { VectorService, SemanticSearchResult } from "../services/VectorService";
import type { SearchWeightService } from "../services/SearchWeightService";
import type { SearchHistoryService } from "../services/SearchHistoryService";
import type { MetadataRepository } from "../database/repositories/MetadataRepository";
import { advancedQueryParser, type ParsedQuery } from "../utils/AdvancedQueryParser";
import { showInfo } from "../utils/notice";
import type { Logger } from "../utils/Logger";
import { RECENT_QUERIES_LIMIT, ALL_NOTES_LIMIT } from "../config/constants";

export interface HybridSearchResult {
	noteId: string;
	title: string;
	filePath: string;
	score: number;
	snippet: string;
	keywordScore: number | null;
	semanticScore: number | null;
	backlinkCount?: number;
	tagMatchCount?: number;
	isHistoryItem?: boolean; // Flag for history suggestions
}

interface SearchConfig {
	keywordWeight: number;
	semanticWeight: number;
}

export class SearchModal extends SuggestModal<HybridSearchResult> {
	private textSearchService: TextSearchService;
	private vectorService: VectorService | null;
	private searchWeightService: SearchWeightService | null;
	private searchHistoryService: SearchHistoryService | null;
	private metadataRepo: MetadataRepository | null;
	private onChoose: (result: HybridSearchResult) => void;
	private config: SearchConfig;
	private lastQuery = "";
	private cachedResults: HybridSearchResult[] = [];
	private isSearching = false;
	private currentQueryId = 0; // Track query to prevent race conditions
	private showingHistory = false;
	private logger: Logger | null;

	constructor(
		app: App,
		textSearchService: TextSearchService,
		vectorService: VectorService | null,
		config: SearchConfig,
		onChoose: (result: HybridSearchResult) => void,
		searchWeightService: SearchWeightService | null = null,
		searchHistoryService: SearchHistoryService | null = null,
		metadataRepo: MetadataRepository | null = null,
		logger: Logger | null = null
	) {
		super(app);
		this.textSearchService = textSearchService;
		this.vectorService = vectorService;
		this.searchWeightService = searchWeightService;
		this.searchHistoryService = searchHistoryService;
		this.metadataRepo = metadataRepo;
		this.config = config;
		this.onChoose = onChoose;
		this.logger = logger;

		// Set placeholder with hint
		this.setPlaceholder("Search notes... (tag: folder: -exclude)");

		// Add custom class for styling
		this.modalEl.addClass("idea-finder-search-modal");
	}

	async getSuggestions(query: string): Promise<HybridSearchResult[]> {
		// Show search history when input is empty
		if (!query.trim()) {
			this.showingHistory = true;
			return this.getHistorySuggestions();
		}

		this.showingHistory = false;

		// Return cached results if query hasn't changed
		if (query === this.lastQuery && this.cachedResults.length > 0) {
			return this.cachedResults;
		}

		this.lastQuery = query;

		// Parse advanced query syntax
		const parsedQuery = advancedQueryParser.parse(query);

		// If only filters with no text query, show filtered results or history
		if (!parsedQuery.textQuery && (parsedQuery.tags.length > 0 || parsedQuery.folder)) {
			this.cachedResults = await this.filterOnlySearch(parsedQuery);
			return this.cachedResults;
		}

		// If no embeddings, use keyword search only
		const hasEmbeddings = this.vectorService?.hasAnyEmbeddings() ?? false;

		if (!hasEmbeddings) {
			this.cachedResults = await this.keywordSearch(parsedQuery.textQuery);
			this.cachedResults = this.applyFilters(this.cachedResults, parsedQuery);
			return this.cachedResults;
		}

		// Use hybrid search (keyword + semantic)
		const results = await this.hybridSearch(parsedQuery.textQuery);
		this.cachedResults = this.applyFilters(results, parsedQuery);
		return this.cachedResults;
	}

	/**
	 * Get search history suggestions.
	 */
	private getHistorySuggestions(): HybridSearchResult[] {
		if (!this.searchHistoryService) {
			return [];
		}

		const recentQueries = this.searchHistoryService.getRecentQueries(RECENT_QUERIES_LIMIT);
		return recentQueries.map((entry) => ({
			noteId: `history_${entry.timestamp}`,
			title: entry.query,
			filePath: `${entry.resultCount} results`,
			score: 1,
			snippet: "",
			keywordScore: null,
			semanticScore: null,
			isHistoryItem: true,
		}));
	}

	/**
	 * Search with only filters (no text query).
	 */
	private async filterOnlySearch(parsedQuery: ParsedQuery): Promise<HybridSearchResult[]> {
		// Get all notes and filter by criteria
		const allNotes = await this.textSearchService.search("", ALL_NOTES_LIMIT);
		return this.applyFilters(
			allNotes.map((r) => ({
				noteId: r.noteId,
				title: r.title,
				filePath: r.filePath,
				score: 1,
				snippet: "",
				keywordScore: null,
				semanticScore: null,
			})),
			parsedQuery
		);
	}

	/**
	 * Apply advanced query filters to results.
	 */
	private applyFilters(
		results: HybridSearchResult[],
		parsedQuery: ParsedQuery
	): HybridSearchResult[] {
		let filtered = results;

		// Filter by folder
		if (parsedQuery.folder) {
			const folderPath = parsedQuery.folder.toLowerCase();
			filtered = filtered.filter((r) =>
				r.filePath.toLowerCase().startsWith(folderPath) ||
				r.filePath.toLowerCase().includes(`/${folderPath}`)
			);
		}

		// Filter by tags
		if (parsedQuery.tags.length > 0 && this.metadataRepo) {
			filtered = filtered.filter((r) => {
				const noteTags = this.metadataRepo!.getTagsForNote(r.noteId);
				const noteTagsLower = noteTags.map((t) => t.toLowerCase());
				// Must have ALL specified tags
				return parsedQuery.tags.every((tag) =>
					noteTagsLower.some((nt) => nt.includes(tag.toLowerCase()))
				);
			});
		}

		// Exclude terms
		if (parsedQuery.excludeTerms.length > 0) {
			filtered = filtered.filter((r) => {
				const titleLower = r.title.toLowerCase();
				const snippetLower = r.snippet.toLowerCase();
				// Must NOT contain any excluded terms
				return !parsedQuery.excludeTerms.some(
					(term) =>
						titleLower.includes(term.toLowerCase()) ||
						snippetLower.includes(term.toLowerCase())
				);
			});
		}

		return filtered;
	}

	private async keywordSearch(query: string): Promise<HybridSearchResult[]> {
		const results = await this.textSearchService.search(query, 20);
		const baseResults = results.map((r) => ({
			noteId: r.noteId,
			title: r.title,
			filePath: r.filePath,
			score: r.score,
			snippet: r.snippet,
			keywordScore: r.score,
			semanticScore: null,
		}));

		// Apply search weights if service is available
		if (this.searchWeightService) {
			const weightedResults = this.searchWeightService.applyWeights(
				baseResults.map((r) => ({
					noteId: r.noteId,
					title: r.title,
					filePath: r.filePath,
					score: r.score,
					snippet: r.snippet,
				})),
				query
			);

			// Normalize and return
			const normalizedResults = this.searchWeightService.normalizeScores(weightedResults);
			return normalizedResults.map((r) => ({
				noteId: r.noteId,
				title: r.title,
				filePath: r.filePath,
				score: r.weightedScore,
				snippet: r.snippet,
				keywordScore: baseResults.find((or) => or.noteId === r.noteId)?.keywordScore ?? null,
				semanticScore: null,
				backlinkCount: r.backlinkCount,
				tagMatchCount: r.tagMatchCount,
			}));
		}

		return baseResults;
	}

	private async hybridSearch(query: string): Promise<HybridSearchResult[]> {
		// Increment query ID to track this specific search
		const queryId = ++this.currentQueryId;

		// Get keyword results first
		const keywordResults = await this.textSearchService.search(query, 30);

		// Return keyword results immediately as a baseline
		const keywordOnlyResults = keywordResults.map((r) => ({
			noteId: r.noteId,
			title: r.title,
			filePath: r.filePath,
			score: r.score,
			snippet: r.snippet,
			keywordScore: r.score,
			semanticScore: null,
		}));

		// If another query started, return current results without updating cache
		if (queryId !== this.currentQueryId) {
			return keywordOnlyResults;
		}

		// Update cache with keyword results
		this.cachedResults = keywordOnlyResults;

		// If already searching for semantic results, return keyword results for now
		if (this.isSearching) {
			return this.cachedResults;
		}

		this.isSearching = true;

		try {
			// Get semantic results asynchronously using smart search
			// (automatically uses chunk embeddings if available)
			let semanticResults: SemanticSearchResult[] = [];
			let semanticFailed = false;

			if (this.vectorService) {
				try {
					// Search using chunk embeddings
					semanticResults = await this.vectorService.search(query, 30);
				} catch (error) {
					this.logger?.error("SearchModal: Semantic search failed:", error);
					semanticFailed = true;
					// Silently fall back to keyword-only
					showInfo("Using keyword search only (semantic unavailable)");
				}
			}

			// Check if query changed while we were waiting for semantic results
			if (queryId !== this.currentQueryId) {
				// Query has changed, discard these results
				return this.cachedResults;
			}

			// Merge results (or just keyword if semantic failed)
			if (!semanticFailed && semanticResults.length > 0) {
				this.cachedResults = this.mergeResults(keywordResults, semanticResults, query);
			}

			return this.cachedResults;
		} finally {
			this.isSearching = false;
		}
	}

	private mergeResults(
		keywordResults: SearchResult[],
		semanticResults: SemanticSearchResult[],
		query: string
	): HybridSearchResult[] {
		// Create maps for quick lookup
		const keywordMap = new Map<string, SearchResult>();
		const semanticMap = new Map<string, SemanticSearchResult>();

		for (const r of keywordResults) {
			keywordMap.set(r.noteId, r);
		}
		for (const r of semanticResults) {
			semanticMap.set(r.noteId, r);
		}

		// Get all unique note IDs
		const allNoteIds = new Set([
			...keywordResults.map((r) => r.noteId),
			...semanticResults.map((r) => r.noteId),
		]);

		// Normalize keyword scores (0-1)
		const kwScores = keywordResults.map((r) => r.score);
		const kwMax = Math.max(...kwScores, 1);
		const kwMin = Math.min(...kwScores, 0);
		const kwRange = kwMax - kwMin || 1;

		const normalizeKeyword = (score: number): number => {
			return (score - kwMin) / kwRange;
		};

		// Calculate hybrid scores
		const results: HybridSearchResult[] = [];

		for (const noteId of allNoteIds) {
			const kwResult = keywordMap.get(noteId);
			const semResult = semanticMap.get(noteId);

			const kwScore = kwResult ? normalizeKeyword(kwResult.score) : null;
			const semScore = semResult ? semResult.similarity : null;

			// Calculate final score
			let finalScore: number;
			if (kwScore !== null && semScore !== null) {
				finalScore =
					kwScore * this.config.keywordWeight +
					semScore * this.config.semanticWeight;
			} else if (kwScore !== null) {
				finalScore = kwScore;
			} else if (semScore !== null) {
				finalScore = semScore;
			} else {
				continue;
			}

			results.push({
				noteId,
				title: kwResult?.title || semResult?.title || "",
				filePath: kwResult?.filePath || semResult?.filePath || "",
				score: finalScore,
				snippet: kwResult?.snippet || "",
				keywordScore: kwScore,
				semanticScore: semScore,
			});
		}

		// Apply search weights if service is available
		if (this.searchWeightService) {
			const weightedResults = this.searchWeightService.applyWeights(
				results.map((r) => ({
					noteId: r.noteId,
					title: r.title,
					filePath: r.filePath,
					score: r.score,
					snippet: r.snippet,
				})),
				query
			);

			// Normalize weighted scores and convert back to HybridSearchResult
			const normalizedResults = this.searchWeightService.normalizeScores(weightedResults);
			return normalizedResults.slice(0, 20).map((r) => ({
				noteId: r.noteId,
				title: r.title,
				filePath: r.filePath,
				score: r.weightedScore,
				snippet: r.snippet,
				keywordScore: results.find((or) => or.noteId === r.noteId)?.keywordScore ?? null,
				semanticScore: results.find((or) => or.noteId === r.noteId)?.semanticScore ?? null,
				backlinkCount: r.backlinkCount,
				tagMatchCount: r.tagMatchCount,
			}));
		}

		// Sort by score descending
		results.sort((a, b) => b.score - a.score);
		return results.slice(0, 20);
	}

	renderSuggestion(result: HybridSearchResult, el: HTMLElement): void {
		// Special rendering for history items
		if (result.isHistoryItem) {
			const container = el.createDiv({ cls: "vibe-search-result vibe-history-item" });

			// History icon
			const iconEl = container.createDiv({ cls: "vibe-history-icon" });
			iconEl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`;

			// Query text
			const titleEl = container.createDiv({ cls: "vibe-search-result-title" });
			titleEl.setText(result.title);

			// Result count
			const pathEl = container.createDiv({ cls: "vibe-search-result-path" });
			pathEl.setText(result.filePath);

			return;
		}

		const container = el.createDiv({ cls: "vibe-search-result" });

		// Title
		const titleEl = container.createDiv({ cls: "vibe-search-result-title" });
		titleEl.setText(result.title || "Untitled");

		// File path
		const pathEl = container.createDiv({ cls: "vibe-search-result-path" });
		pathEl.setText(result.filePath);

		// Snippet
		if (result.snippet) {
			const snippetEl = container.createDiv({ cls: "vibe-search-result-snippet" });
			snippetEl.innerHTML = result.snippet;
		}

		// Score indicator - show weighted score as percentage
		const scoreEl = container.createDiv({ cls: "vibe-search-result-score" });
		const scorePercent = Math.round(Math.min(result.score, 1) * 100);
		scoreEl.setText(`${scorePercent}% match`);
	}

	/**
	 * Override to show empty state message.
	 */
	getEmptyStateText(): string {
		if (!this.lastQuery.trim()) {
			if (this.searchHistoryService && this.searchHistoryService.getCount() === 0) {
				return "Type to search your notes...\n\nTip: Use tag:name, folder:path, or -term for advanced filtering";
			}
			return "Recent searches appear here";
		}

		return `No results found for "${this.lastQuery}"`;
	}

	onChooseSuggestion(result: HybridSearchResult, evt: MouseEvent | KeyboardEvent): void {
		// If it's a history item, fill the search input with the query
		if (result.isHistoryItem) {
			this.inputEl.value = result.title;
			this.inputEl.dispatchEvent(new Event("input"));
			return;
		}

		// Save to history before opening file
		this.searchHistoryService?.addQuery(this.lastQuery, this.cachedResults.length);

		this.onChoose(result);
	}

	/**
	 * Open a file by path.
	 */
	static async openFile(app: App, filePath: string): Promise<void> {
		const file = app.vault.getAbstractFileByPath(filePath);
		if (file instanceof TFile) {
			await app.workspace.getLeaf(false).openFile(file);
		}
	}
}
