import { TFile, type App, type CachedMetadata } from "obsidian";
import { sha256 } from "./vector";

// ========================================
// Types
// ========================================

/**
 * Parsed chunk from markdown content.
 */
export interface ParsedChunk {
	heading: string | null;
	headingLevel: number | null;
	content: string;
	startLine: number;
	contentHash: string;
}

/**
 * Extracted metadata from markdown file.
 */
export interface ParsedMetadata {
	title: string;
	tags: string[];
	links: Array<{ toText: string; resolved: boolean }>;
}

/**
 * Options for chunk parsing.
 */
export interface ChunkingOptions {
	maxHeadingLevel: number; // Split at headings up to this level (1-6), default 2
}

/**
 * Complete parse result.
 */
export interface MarkdownParseResult {
	metadata: ParsedMetadata;
	chunks: ParsedChunk[];
}

// ========================================
// Default Options
// ========================================

const DEFAULT_CHUNKING_OPTIONS: ChunkingOptions = {
	maxHeadingLevel: 2,
};

// ========================================
// MarkdownParser Class
// ========================================

/**
 * Unified Markdown parser for extracting metadata and content chunks.
 * Combines functionality of ChunkParser and metadata extraction.
 */
export class MarkdownParser {
	private chunkingOptions: ChunkingOptions;

	constructor(chunkingOptions: Partial<ChunkingOptions> = {}) {
		this.chunkingOptions = { ...DEFAULT_CHUNKING_OPTIONS, ...chunkingOptions };
	}

	/**
	 * Update chunking options.
	 */
	setChunkingOptions(options: Partial<ChunkingOptions>): void {
		this.chunkingOptions = { ...this.chunkingOptions, ...options };
	}

	/**
	 * Get current chunking options.
	 */
	getChunkingOptions(): ChunkingOptions {
		return { ...this.chunkingOptions };
	}

	// ========================================
	// Metadata Extraction
	// ========================================

	/**
	 * Extract metadata from a file using Obsidian's metadataCache.
	 * This is the preferred method when Obsidian API is available.
	 */
	extractMetadataFromCache(
		file: TFile,
		content: string,
		cache: CachedMetadata | null
	): ParsedMetadata {
		let title = file.basename;
		const tags: Set<string> = new Set();
		const links: Array<{ toText: string; resolved: boolean }> = [];

		if (cache) {
			// Extract title from frontmatter
			if (cache.frontmatter?.title && typeof cache.frontmatter.title === "string") {
				title = cache.frontmatter.title;
			}

			// Extract frontmatter tags
			const frontmatterTags = cache.frontmatter?.tags;
			if (frontmatterTags) {
				if (Array.isArray(frontmatterTags)) {
					frontmatterTags.forEach((t) => {
						if (typeof t === "string" && t.trim()) {
							tags.add(t.trim());
						}
					});
				} else if (typeof frontmatterTags === "string" && frontmatterTags.trim()) {
					tags.add(frontmatterTags.trim());
				}
			}

			// Extract inline #tags from body
			if (cache.tags) {
				cache.tags.forEach((tagCache) => {
					const tag = tagCache.tag.replace(/^#/, "");
					if (tag.trim()) {
						tags.add(tag.trim());
					}
				});
			}

			// Extract [[wikilinks]] from cache
			if (cache.links) {
				for (const linkCache of cache.links) {
					links.push({
						toText: linkCache.link,
						resolved: false, // Will be resolved by caller with NoteRepository
					});
				}
			}
		}

		// Fallback: Try first H1 if no frontmatter title
		if (title === file.basename) {
			const extractedTitle = this.extractTitleFromContent(content);
			if (extractedTitle) {
				title = extractedTitle;
			}
		}

		return {
			title,
			tags: Array.from(tags),
			links,
		};
	}

	/**
	 * Extract metadata from content without Obsidian API (fallback/standalone).
	 * Uses regex-based parsing.
	 */
	extractMetadataFromContent(content: string, filename: string): ParsedMetadata {
		let title = filename.replace(/\.md$/, "");
		const tags: Set<string> = new Set();
		const links: Array<{ toText: string; resolved: boolean }> = [];

		// Extract frontmatter
		const frontmatter = this.extractFrontmatter(content);
		if (frontmatter) {
			// Extract title from frontmatter
			const titleMatch = frontmatter.match(/^title:\s*["']?(.+?)["']?\s*$/m);
			if (titleMatch && titleMatch[1]) {
				title = titleMatch[1].trim();
			}

			// Extract tags from frontmatter
			const tagsMatch = frontmatter.match(/^tags:\s*\[([^\]]+)\]/m);
			if (tagsMatch && tagsMatch[1]) {
				tagsMatch[1].split(",").forEach((tag) => {
					const cleaned = tag.trim().replace(/["']/g, "");
					if (cleaned) tags.add(cleaned);
				});
			}

			// Also check for YAML array format
			const yamlTagsMatch = frontmatter.match(/^tags:\s*\n((?:\s*-\s*.+\n?)+)/m);
			if (yamlTagsMatch && yamlTagsMatch[1]) {
				yamlTagsMatch[1].match(/-\s*(.+)/g)?.forEach((match) => {
					const tag = match.replace(/^-\s*/, "").trim().replace(/["']/g, "");
					if (tag) tags.add(tag);
				});
			}
		}

		// Extract title from first H1 (if not found in frontmatter)
		if (title === filename.replace(/\.md$/, "")) {
			const extractedTitle = this.extractTitleFromContent(content);
			if (extractedTitle) {
				title = extractedTitle;
			}
		}

		// Extract inline #tags
		const inlineTagMatches = content.match(/#[\w\u4e00-\u9fff][\w\u4e00-\u9fff/-]*/g);
		if (inlineTagMatches) {
			inlineTagMatches.forEach((tag) => {
				// Skip headings (lines starting with #)
				const cleaned = tag.slice(1); // Remove #
				if (cleaned && !cleaned.startsWith(" ")) {
					tags.add(cleaned);
				}
			});
		}

		// Extract [[wikilinks]]
		const linkMatches = content.match(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g);
		if (linkMatches) {
			linkMatches.forEach((match) => {
				const linkText = match.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/, "$1");
				links.push({
					toText: linkText,
					resolved: false,
				});
			});
		}

		return {
			title,
			tags: Array.from(tags),
			links,
		};
	}

	/**
	 * Extract title from content (first H1 heading).
	 */
	private extractTitleFromContent(content: string): string | null {
		const h1Match = content.match(/^#\s+(.+)$/m);
		if (h1Match && h1Match[1]) {
			return h1Match[1].trim();
		}
		return null;
	}

	/**
	 * Extract frontmatter from content.
	 */
	private extractFrontmatter(content: string): string | null {
		const match = content.match(/^---\n([\s\S]*?)\n---/);
		return match ? match[1] : null;
	}

	// ========================================
	// Chunk Parsing
	// ========================================

	/**
	 * Parse markdown content into chunks based on headings.
	 */
	async parseChunks(content: string): Promise<ParsedChunk[]> {
		const lines = content.split("\n");
		const chunks: ParsedChunk[] = [];
		const headingRegex = /^(#{1,6})\s+(.+)$/;

		let currentChunk: {
			heading: string | null;
			headingLevel: number | null;
			lines: string[];
			startLine: number;
		} = {
			heading: null,
			headingLevel: null,
			lines: [],
			startLine: 0,
		};

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const match = line.match(headingRegex);

			if (match) {
				const level = match[1].length;
				const headingText = match[2].trim();

				// Check if this heading level should trigger a split
				if (level <= this.chunkingOptions.maxHeadingLevel) {
					// Save current chunk if it has content
					if (currentChunk.lines.length > 0) {
						const chunkContent = currentChunk.lines.join("\n").trim();
						if (chunkContent.length > 0) {
							chunks.push({
								heading: currentChunk.heading,
								headingLevel: currentChunk.headingLevel,
								content: chunkContent,
								startLine: currentChunk.startLine,
								contentHash: await sha256(chunkContent),
							});
						}
					}

					// Start new chunk with this heading
					currentChunk = {
						heading: headingText,
						headingLevel: level,
						lines: [line],
						startLine: i,
					};
					continue;
				}
			}

			// Add line to current chunk
			currentChunk.lines.push(line);
		}

		// Don't forget the last chunk
		if (currentChunk.lines.length > 0) {
			const chunkContent = currentChunk.lines.join("\n").trim();
			if (chunkContent.length > 0) {
				chunks.push({
					heading: currentChunk.heading,
					headingLevel: currentChunk.headingLevel,
					content: chunkContent,
					startLine: currentChunk.startLine,
					contentHash: await sha256(chunkContent),
				});
			}
		}

		// If no chunks were created, return entire content as single chunk
		if (chunks.length === 0 && content.trim().length > 0) {
			chunks.push({
				heading: null,
				headingLevel: null,
				content: content.trim(),
				startLine: 0,
				contentHash: await sha256(content.trim()),
			});
		}

		return chunks;
	}

	// ========================================
	// Combined Parsing
	// ========================================

	/**
	 * Parse both metadata and chunks from content.
	 * Uses Obsidian API when available.
	 */
	async parseAll(
		file: TFile,
		content: string,
		cache: CachedMetadata | null
	): Promise<MarkdownParseResult> {
		const metadata = this.extractMetadataFromCache(file, content, cache);
		const chunks = await this.parseChunks(content);

		return { metadata, chunks };
	}

	/**
	 * Parse both metadata and chunks from content (standalone, no Obsidian API).
	 */
	async parseAllStandalone(content: string, filename: string): Promise<MarkdownParseResult> {
		const metadata = this.extractMetadataFromContent(content, filename);
		const chunks = await this.parseChunks(content);

		return { metadata, chunks };
	}
}

// ========================================
// Singleton Instance
// ========================================

let defaultParser: MarkdownParser | null = null;

/**
 * Get the default MarkdownParser instance.
 */
export function getMarkdownParser(options?: Partial<ChunkingOptions>): MarkdownParser {
	if (!defaultParser) {
		defaultParser = new MarkdownParser(options);
	} else if (options) {
		defaultParser.setChunkingOptions(options);
	}
	return defaultParser;
}
