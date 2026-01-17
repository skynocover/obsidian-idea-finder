import type { Logger } from "../utils/Logger";

/**
 * Represents a search history entry.
 */
export interface SearchHistoryEntry {
	query: string;
	timestamp: number;
	resultCount: number;
}

/**
 * Service for managing search history.
 */
export class SearchHistoryService {
	private history: SearchHistoryEntry[] = [];
	private maxHistorySize: number;
	private storageKey: string;
	private loadData: () => Promise<Record<string, unknown>>;
	private saveData: (data: Record<string, unknown>) => Promise<void>;
	private logger: Logger | null;

	constructor(
		loadData: () => Promise<Record<string, unknown>>,
		saveData: (data: Record<string, unknown>) => Promise<void>,
		maxHistorySize: number = 50,
		storageKey: string = "searchHistory",
		logger: Logger | null = null
	) {
		this.loadData = loadData;
		this.saveData = saveData;
		this.maxHistorySize = maxHistorySize;
		this.storageKey = storageKey;
		this.logger = logger;
	}

	/**
	 * Load search history from storage.
	 */
	async load(): Promise<void> {
		try {
			const data = await this.loadData();
			const history = data[this.storageKey];
			if (Array.isArray(history)) {
				this.history = history.filter(
					(entry): entry is SearchHistoryEntry =>
						typeof entry === "object" &&
						typeof entry.query === "string" &&
						typeof entry.timestamp === "number"
				);
			}
		} catch (error) {
			this.logger?.error("SearchHistory: Failed to load:", error);
			this.history = [];
		}
	}

	/**
	 * Save search history to storage.
	 */
	private async save(): Promise<void> {
		try {
			const data = await this.loadData();
			data[this.storageKey] = this.history;
			await this.saveData(data);
		} catch (error) {
			this.logger?.error("SearchHistory: Failed to save:", error);
		}
	}

	/**
	 * Add a search query to history.
	 */
	async addQuery(query: string, resultCount: number = 0): Promise<void> {
		const trimmedQuery = query.trim();
		if (!trimmedQuery) return;

		// Remove existing entry with same query
		this.history = this.history.filter(
			(entry) => entry.query.toLowerCase() !== trimmedQuery.toLowerCase()
		);

		// Add new entry at the beginning
		this.history.unshift({
			query: trimmedQuery,
			timestamp: Date.now(),
			resultCount,
		});

		// Trim to max size
		if (this.history.length > this.maxHistorySize) {
			this.history = this.history.slice(0, this.maxHistorySize);
		}

		await this.save();
	}

	/**
	 * Get recent search queries.
	 */
	getRecentQueries(limit: number = 10): SearchHistoryEntry[] {
		return this.history.slice(0, limit);
	}

	/**
	 * Get search suggestions based on current input.
	 * Returns queries that start with the input prefix.
	 */
	getSuggestions(prefix: string, limit: number = 5): SearchHistoryEntry[] {
		if (!prefix.trim()) {
			return this.getRecentQueries(limit);
		}

		const lowerPrefix = prefix.toLowerCase();
		return this.history
			.filter((entry) => entry.query.toLowerCase().startsWith(lowerPrefix))
			.slice(0, limit);
	}

	/**
	 * Clear search history.
	 */
	async clear(): Promise<void> {
		this.history = [];
		await this.save();
	}

	/**
	 * Remove a specific query from history.
	 */
	async removeQuery(query: string): Promise<void> {
		this.history = this.history.filter(
			(entry) => entry.query.toLowerCase() !== query.toLowerCase()
		);
		await this.save();
	}

	/**
	 * Get total history count.
	 */
	getCount(): number {
		return this.history.length;
	}
}
