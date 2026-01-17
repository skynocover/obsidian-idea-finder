/**
 * Parsed query with filters extracted.
 */
export interface ParsedQuery {
	/** The main text query (without filter operators) */
	textQuery: string;
	/** Tag filters (tag:xxx or #xxx) */
	tags: string[];
	/** Folder filter (folder:xxx or in:xxx) */
	folder: string | null;
	/** Exclude filter (-xxx or NOT xxx) */
	excludeTerms: string[];
	/** Original query string */
	originalQuery: string;
}

/**
 * Parses advanced search queries with special syntax.
 *
 * Supported syntax:
 * - tag:name or #name - Filter by tag
 * - folder:path or in:path - Filter by folder
 * - -term - Exclude results containing term
 * - "exact phrase" - Search for exact phrase
 *
 * Examples:
 * - "machine learning" tag:ai folder:notes
 * - #programming -javascript in:projects
 */
export class AdvancedQueryParser {
	/**
	 * Parse a query string into structured components.
	 */
	parse(query: string): ParsedQuery {
		const result: ParsedQuery = {
			textQuery: "",
			tags: [],
			folder: null,
			excludeTerms: [],
			originalQuery: query,
		};

		if (!query.trim()) {
			return result;
		}

		// Extract quoted phrases first (preserve them)
		const quotedPhrases: string[] = [];
		let processedQuery = query.replace(/"([^"]+)"/g, (_, phrase) => {
			quotedPhrases.push(phrase);
			return `__QUOTED_${quotedPhrases.length - 1}__`;
		});

		// Split into tokens
		const tokens = processedQuery.split(/\s+/).filter((t) => t.length > 0);
		const textTokens: string[] = [];

		for (const token of tokens) {
			// Tag filter: tag:name or #name
			if (token.startsWith("tag:")) {
				const tag = token.slice(4).trim();
				if (tag) result.tags.push(tag);
				continue;
			}

			if (token.startsWith("#") && token.length > 1) {
				const tag = token.slice(1).trim();
				if (tag) result.tags.push(tag);
				continue;
			}

			// Folder filter: folder:path or in:path
			if (token.startsWith("folder:")) {
				result.folder = token.slice(7).trim() || null;
				continue;
			}

			if (token.startsWith("in:")) {
				result.folder = token.slice(3).trim() || null;
				continue;
			}

			// Exclude filter: -term
			if (token.startsWith("-") && token.length > 1) {
				const term = token.slice(1).trim();
				if (term) result.excludeTerms.push(term);
				continue;
			}

			// Regular text token
			textTokens.push(token);
		}

		// Reconstruct text query with quoted phrases restored
		result.textQuery = textTokens
			.map((t) => {
				const match = t.match(/__QUOTED_(\d+)__/);
				if (match) {
					const index = parseInt(match[1], 10);
					return `"${quotedPhrases[index]}"`;
				}
				return t;
			})
			.join(" ")
			.trim();

		return result;
	}

	/**
	 * Check if a query contains advanced syntax.
	 */
	hasAdvancedSyntax(query: string): boolean {
		const patterns = [
			/tag:\S+/,
			/#\S+/,
			/folder:\S+/,
			/in:\S+/,
			/-\S+/,
			/"[^"]+"/,
		];

		return patterns.some((pattern) => pattern.test(query));
	}

	/**
	 * Generate syntax help text.
	 */
	static getHelpText(): string {
		return `Advanced Search Syntax:
• tag:name or #name - Filter by tag
• folder:path or in:path - Filter by folder
• -term - Exclude term from results
• "exact phrase" - Search exact phrase

Examples:
• "machine learning" tag:ai
• #programming -javascript in:notes`;
	}
}

/**
 * Default parser instance.
 */
export const advancedQueryParser = new AdvancedQueryParser();
