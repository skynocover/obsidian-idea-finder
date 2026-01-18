import { App, SuggestModal, TFile } from "obsidian";
import type { TextSearchService, SearchResult } from "../services/TextSearchService";
import type { VectorService, SemanticSearchResult } from "../services/VectorService";
import type { SearchWeightService } from "../services/SearchWeightService";
import type { SearchHistoryService } from "../services/SearchHistoryService";
import type { MetadataRepository } from "../database/repositories/MetadataRepository";
import { advancedQueryParser, type ParsedQuery } from "../utils/AdvancedQueryParser";
import { showInfo } from "../utils/notice";
import type { Logger } from "../utils/Logger";
import { RECENT_QUERIES_LIMIT } from "../config/constants";

export interface ChunkSearchResult {
	chunkId: string;
	noteId: string;
	title: string;
	heading: string;
	filePath: string;
	score: number;
	snippet: string;
	startLine: number;
	keywordScore: number | null;
	semanticScore: number | null;
	backlinkCount?: number;
	tagMatchCount?: number;
	isHistoryItem?: boolean;
}

interface SearchConfig {
	keywordWeight: number;
	semanticWeight: number;
	searchThreshold: number;
}

export class SearchModal extends SuggestModal<ChunkSearchResult> {
	private textSearchService: TextSearchService;
	private vectorService: VectorService | null;
	private searchWeightService: SearchWeightService | null;
	private searchHistoryService: SearchHistoryService | null;
	private metadataRepo: MetadataRepository | null;
	private onChoose: (result: ChunkSearchResult) => void;
	private config: SearchConfig;
	private lastQuery = "";
	private cachedResults: ChunkSearchResult[] = [];
	private isSearching = false;
	private currentQueryId = 0;
	private showingHistory = false;
	private logger: Logger | null;

	constructor(
		app: App,
		textSearchService: TextSearchService,
		vectorService: VectorService | null,
		config: SearchConfig,
		onChoose: (result: ChunkSearchResult) => void,
		searchWeightService: SearchWeightService | null = null,
		searchHistoryService: SearchHistoryService | null = null,
		metadataRepo: MetadataRepository | null = null,
		logger: Logger | null = null
	) {
		super(app);
		this.textSearchService = textSearchService;
		this.vectorService = vectorService;
		this.config = config;
		this.searchWeightService = searchWeightService;
		this.searchHistoryService = searchHistoryService;
		this.metadataRepo = metadataRepo;
		this.onChoose = onChoose;
		this.logger = logger;

		// Set placeholder with hint
		this.setPlaceholder("Search notes... (tag: folder: -exclude)");

		// Add custom class for styling
		this.modalEl.addClass("idea-finder-search-modal");
	}

	async getSuggestions(query: string): Promise<ChunkSearchResult[]> {
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

		// If only filters with no text query, return empty
		if (!parsedQuery.textQuery) {
			return [];
		}

		// Check if we have embeddings for hybrid search
		const hasEmbeddings = this.vectorService?.hasAnyEmbeddings() ?? false;

		if (!hasEmbeddings || this.config.semanticWeight === 0) {
			// Use keyword search only
			const results = await this.keywordSearch(parsedQuery.textQuery);
			this.cachedResults = this.applyFilters(results, parsedQuery);
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
	private getHistorySuggestions(): ChunkSearchResult[] {
		if (!this.searchHistoryService) {
			return [];
		}

		const recentQueries = this.searchHistoryService.getRecentQueries(RECENT_QUERIES_LIMIT);
		return recentQueries.map((entry) => ({
			chunkId: `history_${entry.timestamp}`,
			noteId: `history_${entry.timestamp}`,
			title: entry.query,
			heading: "",
			filePath: `${entry.resultCount} results`,
			score: 1,
			snippet: "",
			startLine: 0,
			keywordScore: null,
			semanticScore: null,
			isHistoryItem: true,
		}));
	}

	/**
	 * Apply advanced query filters to results.
	 */
	private applyFilters(
		results: ChunkSearchResult[],
		parsedQuery: ParsedQuery
	): ChunkSearchResult[] {
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
				const headingLower = r.heading.toLowerCase();
				// Must NOT contain any excluded terms
				return !parsedQuery.excludeTerms.some(
					(term) =>
						titleLower.includes(term.toLowerCase()) ||
						snippetLower.includes(term.toLowerCase()) ||
						headingLower.includes(term.toLowerCase())
				);
			});
		}

		return filtered;
	}

	private async keywordSearch(query: string): Promise<ChunkSearchResult[]> {
		const results = await this.textSearchService.search(query, 30);

		// Get threshold (as 0-1 value)
		const threshold = this.config.searchThreshold / 100;

		// Normalize scores (max score = 1)
		const maxScore = Math.max(...results.map((r) => r.score), 1);

		const baseResults: ChunkSearchResult[] = results.map((r) => ({
			chunkId: r.chunkId,
			noteId: r.noteId,
			title: r.title,
			heading: r.heading,
			filePath: r.filePath,
			score: r.score / maxScore,
			snippet: r.snippet,
			startLine: r.startLine,
			keywordScore: r.score / maxScore,
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

			const normalizedResults = this.searchWeightService.normalizeScores(weightedResults);
			const normalizedMap = new Map(normalizedResults.map((r) => [r.noteId, r]));

			return baseResults.map((r) => {
				const normalized = normalizedMap.get(r.noteId);
				return {
					...r,
					score: normalized?.weightedScore ?? r.score,
					backlinkCount: normalized?.backlinkCount,
					tagMatchCount: normalized?.tagMatchCount,
				};
			})
				.filter((r) => r.score >= threshold)
				.sort((a, b) => b.score - a.score)
				.slice(0, 20);
		}

		return baseResults
			.filter((r) => r.score >= threshold)
			.sort((a, b) => b.score - a.score)
			.slice(0, 20);
	}

	private async hybridSearch(query: string): Promise<ChunkSearchResult[]> {
		// Increment query ID to track this specific search
		const queryId = ++this.currentQueryId;

		// Get keyword results first
		const keywordResults = await this.textSearchService.search(query, 30);

		// Normalize keyword scores
		const kwMax = Math.max(...keywordResults.map((r) => r.score), 1);

		// Return keyword results immediately as a baseline
		const keywordOnlyResults: ChunkSearchResult[] = keywordResults.map((r) => ({
			chunkId: r.chunkId,
			noteId: r.noteId,
			title: r.title,
			heading: r.heading,
			filePath: r.filePath,
			score: r.score / kwMax,
			snippet: r.snippet,
			startLine: r.startLine,
			keywordScore: r.score / kwMax,
			semanticScore: null,
		}));

		// If another query started, return current results
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
			let semanticResults: SemanticSearchResult[] = [];
			let semanticFailed = false;

			if (this.vectorService) {
				try {
					semanticResults = await this.vectorService.search(query, 30);
				} catch (error) {
					this.logger?.error("SearchModal: Semantic search failed:", error);
					semanticFailed = true;
					showInfo("Using keyword search only (semantic unavailable)");
				}
			}

			// Check if query changed while waiting
			if (queryId !== this.currentQueryId) {
				return this.cachedResults;
			}

			// Merge results
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
	): ChunkSearchResult[] {
		// Get threshold (as 0-1 value)
		const threshold = this.config.searchThreshold / 100;

		// Create maps for quick lookup (by chunkId)
		const keywordMap = new Map<string, SearchResult>();
		const semanticMap = new Map<string, SemanticSearchResult>();

		for (const r of keywordResults) {
			keywordMap.set(r.chunkId, r);
		}
		for (const r of semanticResults) {
			semanticMap.set(r.chunkId, r);
		}

		// Get all unique chunk IDs
		const allChunkIds = new Set([
			...keywordResults.map((r) => r.chunkId),
			...semanticResults.map((r) => r.chunkId),
		]);

		// Normalize keyword scores (0-1)
		const kwScores = keywordResults.map((r) => r.score);
		const kwMax = Math.max(...kwScores, 1);

		const normalizeKeyword = (score: number): number => score / kwMax;

		// Calculate hybrid scores
		const results: ChunkSearchResult[] = [];

		for (const chunkId of allChunkIds) {
			const kwResult = keywordMap.get(chunkId);
			const semResult = semanticMap.get(chunkId);

			const kwScore = kwResult ? normalizeKeyword(kwResult.score) : null;
			const semScore = semResult ? semResult.similarity : null;

			// Calculate final score
			let finalScore: number;
			if (kwScore !== null && semScore !== null) {
				finalScore =
					kwScore * this.config.keywordWeight +
					semScore * this.config.semanticWeight;
			} else if (kwScore !== null) {
				finalScore = kwScore * this.config.keywordWeight;
			} else if (semScore !== null) {
				finalScore = semScore * this.config.semanticWeight;
			} else {
				continue;
			}

			results.push({
				chunkId,
				noteId: kwResult?.noteId || semResult?.noteId || "",
				title: kwResult?.title || semResult?.title || "",
				heading: kwResult?.heading || semResult?.heading || "",
				filePath: kwResult?.filePath || semResult?.filePath || "",
				score: finalScore,
				snippet: kwResult?.snippet || "",
				startLine: kwResult?.startLine || semResult?.startLine || 0,
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

			const normalizedResults = this.searchWeightService.normalizeScores(weightedResults);
			const normalizedMap = new Map(normalizedResults.map((r) => [r.noteId, r]));

			return results.map((r) => {
				const normalized = normalizedMap.get(r.noteId);
				return {
					...r,
					score: normalized?.weightedScore ?? r.score,
					backlinkCount: normalized?.backlinkCount,
					tagMatchCount: normalized?.tagMatchCount,
				};
			})
				.filter((r) => r.score >= threshold)
				.sort((a, b) => b.score - a.score)
				.slice(0, 20);
		}

		// Sort by score and filter by threshold
		return results
			.filter((r) => r.score >= threshold)
			.sort((a, b) => b.score - a.score)
			.slice(0, 20);
	}

	renderSuggestion(result: ChunkSearchResult, el: HTMLElement): void {
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

		// Title with optional heading
		const titleEl = container.createDiv({ cls: "vibe-search-result-title" });
		if (result.heading) {
			titleEl.setText(`${result.title || "Untitled"} > ${result.heading}`);
		} else {
			titleEl.setText(result.title || "Untitled");
		}

		// File path
		const pathEl = container.createDiv({ cls: "vibe-search-result-path" });
		pathEl.setText(result.filePath);

		// Snippet
		if (result.snippet) {
			const snippetEl = container.createDiv({ cls: "vibe-search-result-snippet" });
			snippetEl.innerHTML = result.snippet;
		}

		// Score indicator - show as percentage
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

	onChooseSuggestion(result: ChunkSearchResult, evt: MouseEvent | KeyboardEvent): void {
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
	 * Open a file by path, optionally jumping to a specific line.
	 */
	static async openFile(app: App, filePath: string, line?: number): Promise<void> {
		const file = app.vault.getAbstractFileByPath(filePath);
		if (file instanceof TFile) {
			const leaf = app.workspace.getLeaf(false);
			await leaf.openFile(file);

			// Jump to specific line if provided
			if (line !== undefined && line > 0) {
				const view = leaf.view;
				if (view.getViewType() === "markdown") {
					// Use Obsidian's editor to scroll to line
					const editor = (view as any).editor;
					if (editor) {
						editor.setCursor({ line: line - 1, ch: 0 });
						editor.scrollIntoView({ from: { line: line - 1, ch: 0 }, to: { line: line - 1, ch: 0 } }, true);
					}
				}
			}
		}
	}
}
