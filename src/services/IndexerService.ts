import { TFile, type App } from "obsidian";
import type { NoteRepository } from "../database/repositories/NoteRepository";
import type { VectorRepository } from "../database/repositories/VectorRepository";
import type { MetadataRepository } from "../database/repositories/MetadataRepository";
import type { ChunkRepository } from "../database/repositories/ChunkRepository";
import { MarkdownParser, type ChunkingOptions } from "../utils/MarkdownParser";
import type { FolderFilterSettings } from "../settings";
import type { FileChangeEvent } from "./FileWatcherService";
import type { Logger } from "../utils/Logger";
import { sha256, sleep } from "../utils/vector";
import { shouldFilterPath } from "../utils/path";

export interface IndexerCallbacks {
	onProgress?: (current: number, total: number) => void;
	onComplete?: (totalIndexed: number) => void;
	onFileIndexed?: (path: string) => void;
	onProgressivePhase?: (phase: "priority" | "background", current: number, total: number) => void;
}

export interface ProgressiveIndexOptions {
	priorityBatchSize: number;
	backgroundBatchSize: number;
	backgroundBatchDelayMs: number;
}

export interface IndexerOptions {
	getFolderFilter: () => FolderFilterSettings;
	getChunkingOptions?: () => ChunkingOptions;
}

/**
 * IndexerService - Only responsible for indexing logic.
 * File watching is handled by FileWatcherService.
 */
export class IndexerService {
	private app: App;
	private noteRepo: NoteRepository;
	private vectorRepo: VectorRepository | null;
	private metadataRepo: MetadataRepository | null;
	private chunkRepo: ChunkRepository | null;
	private markdownParser: MarkdownParser;
	private callbacks: IndexerCallbacks;
	private options: IndexerOptions;
	private isIndexing = false;
	private saveCallback: () => Promise<void>;
	private logger: Logger | null;

	// Progressive indexing configuration
	private static readonly DEFAULT_PROGRESSIVE_OPTIONS: ProgressiveIndexOptions = {
		priorityBatchSize: 50,
		backgroundBatchSize: 20,
		backgroundBatchDelayMs: 100,
	};
	private progressiveOptions: ProgressiveIndexOptions;
	private backgroundIndexAbortController: AbortController | null = null;

	constructor(
		app: App,
		noteRepo: NoteRepository,
		saveCallback: () => Promise<void>,
		callbacks: IndexerCallbacks = {},
		options: IndexerOptions = { getFolderFilter: () => ({ mode: "exclude", folders: [] }) },
		metadataRepo: MetadataRepository | null = null,
		chunkRepo: ChunkRepository | null = null,
		vectorRepo: VectorRepository | null = null,
		logger: Logger | null = null
	) {
		this.app = app;
		this.noteRepo = noteRepo;
		this.vectorRepo = vectorRepo;
		this.metadataRepo = metadataRepo;
		this.chunkRepo = chunkRepo;
		this.saveCallback = saveCallback;
		this.callbacks = callbacks;
		this.options = options;
		this.logger = logger;

		// Initialize markdown parser with default options
		const chunkingOpts = this.options.getChunkingOptions?.() ?? { maxHeadingLevel: 2, minChunkLength: 50 };
		this.markdownParser = new MarkdownParser(chunkingOpts);

		// Initialize progressive indexing options
		this.progressiveOptions = { ...IndexerService.DEFAULT_PROGRESSIVE_OPTIONS };
	}

	/**
	 * Update progressive indexing options.
	 */
	setProgressiveOptions(options: Partial<ProgressiveIndexOptions>): void {
		this.progressiveOptions = { ...this.progressiveOptions, ...options };
	}

	/**
	 * Check if a file path should be filtered out based on folder filter settings.
	 */
	private isPathFiltered(filePath: string): boolean {
		return shouldFilterPath(filePath, this.options.getFolderFilter());
	}

	/**
	 * Process file change events from FileWatcherService.
	 * This is the bridge between file watching and indexing.
	 */
	async processFileChangeEvents(events: FileChangeEvent[]): Promise<void> {
		if (events.length === 0) return;

		this.logger?.info(`Indexer: Processing ${events.length} file change events`);

		for (const event of events) {
			try {
				switch (event.type) {
					case "create":
					case "modify":
						if (event.file) {
							await this.indexFile(event.file);
							this.callbacks.onFileIndexed?.(event.path);
						}
						break;
					case "delete":
						this.removeFile(event.path);
						break;
					case "rename":
						if (event.file && event.oldPath) {
							await this.handleRenameFile(event.oldPath, event.file);
							this.callbacks.onFileIndexed?.(event.path);
						}
						break;
				}
			} catch (error) {
				this.logger?.error(`Indexer: Error processing ${event.path}:`, error);
			}
		}

		// Save database once after all changes
		await this.saveCallback();
	}

	/**
	 * Index all markdown files in the vault.
	 */
	async indexAll(): Promise<number> {
		if (this.isIndexing) {
			this.logger?.debug("Indexer: Already indexing, skipping...");
			return 0;
		}

		this.isIndexing = true;
		this.logger?.info("Indexer: Starting full index...");

		try {
			const allFiles = this.app.vault.getMarkdownFiles();
			// Apply folder filter
			const files = allFiles.filter((file) => !this.isPathFiltered(file.path));
			const total = files.length;
			let indexed = 0;

			this.logger?.info(`Indexer: Indexing ${files.length}/${allFiles.length} files (after filter)`);

			for (const file of files) {
				await this.indexFile(file);
				indexed++;
				this.callbacks.onProgress?.(indexed, total);
			}

			// Clean up deleted files (also considers filtered files as "deleted" from index)
			await this.cleanupDeletedFiles(files);

			// Save database
			await this.saveCallback();

			this.callbacks.onComplete?.(indexed);
			this.logger?.info(`Indexer: Indexed ${indexed} files`);
			return indexed;
		} finally {
			this.isIndexing = false;
		}
	}

	/**
	 * Index all markdown files progressively.
	 * First indexes priority files (recently modified), then processes remaining files in background batches.
	 * This prevents UI blocking on large vaults.
	 */
	async indexAllProgressive(): Promise<number> {
		if (this.isIndexing) {
			this.logger?.debug("Indexer: Already indexing, skipping...");
			return 0;
		}

		this.isIndexing = true;
		this.backgroundIndexAbortController = new AbortController();
		this.logger?.info("Indexer: Starting progressive index...");

		try {
			const allFiles = this.app.vault.getMarkdownFiles();
			// Apply folder filter
			const files = allFiles.filter((file) => !this.isPathFiltered(file.path));
			const total = files.length;

			this.logger?.info(`Indexer: Progressive indexing ${files.length}/${allFiles.length} files (after filter)`);

			// Sort files by modification time (most recent first)
			const sortedFiles = [...files].sort((a, b) => b.stat.mtime - a.stat.mtime);

			// Phase 1: Index priority batch (most recently modified files)
			const { priorityBatchSize, backgroundBatchSize, backgroundBatchDelayMs } = this.progressiveOptions;
			const priorityFiles = sortedFiles.slice(0, priorityBatchSize);
			const backgroundFiles = sortedFiles.slice(priorityBatchSize);

			let indexed = 0;

			// Index priority files synchronously
			this.logger?.debug(`Indexer: Indexing ${priorityFiles.length} priority files...`);
			for (const file of priorityFiles) {
				await this.indexFile(file);
				indexed++;
				this.callbacks.onProgress?.(indexed, total);
				this.callbacks.onProgressivePhase?.("priority", indexed, priorityFiles.length);
			}

			// Save after priority batch
			await this.saveCallback();
			this.logger?.debug(`Indexer: Priority batch complete (${priorityFiles.length} files)`);

			// Phase 2: Index remaining files in background batches
			if (backgroundFiles.length > 0) {
				this.logger?.debug(`Indexer: Starting background indexing of ${backgroundFiles.length} files...`);

				for (let i = 0; i < backgroundFiles.length; i += backgroundBatchSize) {
					// Check if aborted
					if (this.backgroundIndexAbortController?.signal.aborted) {
						this.logger?.info("Indexer: Background indexing aborted");
						break;
					}

					const batch = backgroundFiles.slice(i, i + backgroundBatchSize);

					// Process batch
					for (const file of batch) {
						if (this.backgroundIndexAbortController?.signal.aborted) break;
						await this.indexFile(file);
						indexed++;
						this.callbacks.onProgress?.(indexed, total);
						this.callbacks.onProgressivePhase?.("background", indexed - priorityFiles.length, backgroundFiles.length);
					}

					// Save after each batch
					await this.saveCallback();

					// Yield to main thread between batches
					if (i + backgroundBatchSize < backgroundFiles.length) {
						await sleep(backgroundBatchDelayMs);
					}
				}
			}

			// Clean up deleted files
			await this.cleanupDeletedFiles(files);
			await this.saveCallback();

			this.callbacks.onComplete?.(indexed);
			this.logger?.info(`Indexer: Progressive indexing complete (${indexed} files)`);
			return indexed;
		} finally {
			this.isIndexing = false;
			this.backgroundIndexAbortController = null;
		}
	}

	/**
	 * Abort any running background indexing.
	 */
	abortBackgroundIndexing(): void {
		if (this.backgroundIndexAbortController) {
			this.backgroundIndexAbortController.abort();
			this.logger?.info("Indexer: Background indexing abort requested");
		}
	}

	/**
	 * Index a single file.
	 */
	async indexFile(file: TFile): Promise<void> {
		try {
			const content = await this.app.vault.cachedRead(file);
			const contentHash = await sha256(content);

			// Check if already indexed with same hash
			const existing = this.noteRepo.getNoteByPath(file.path);
			if (existing && existing.contentHash === contentHash) {
				return; // No changes
			}

			const { title, tags, links } = this.extractMetadata(file, content);
			const id = existing?.id || this.generateNoteId(file.path);

			this.noteRepo.upsertNote({
				id,
				filePath: file.path,
				title,
				contentHash,
			});

			// Store tags and links if MetadataRepository is available
			if (this.metadataRepo) {
				this.metadataRepo.setTagsForNote(id, tags);
				this.metadataRepo.setLinksForNote(id, links);
			}

			// Parse and store chunks if ChunkRepository is available
			if (this.chunkRepo) {
				// Update markdown parser options if they might have changed
				const chunkingOpts = this.options.getChunkingOptions?.();
				if (chunkingOpts) {
					this.markdownParser.setChunkingOptions(chunkingOpts);
				}

				// Parse content into chunks
				const parsedChunks = await this.markdownParser.parseChunks(content);

				// Get existing chunk IDs for this note to track what to delete
				const existingChunks = this.chunkRepo.getChunksByNoteId(id);
				const existingChunkIds = new Set(existingChunks.map(c => c.id));
				const newChunkIds = new Set<string>();

				// Upsert each chunk
				for (let i = 0; i < parsedChunks.length; i++) {
					const parsed = parsedChunks[i];
					const chunkId = this.generateChunkId(id, i, parsed.startLine);
					newChunkIds.add(chunkId);

					this.chunkRepo.upsertChunk({
						id: chunkId,
						noteId: id,
						heading: parsed.heading,
						headingLevel: parsed.headingLevel,
						content: parsed.content,
						startLine: parsed.startLine,
						contentHash: parsed.contentHash,
					});
				}

				// Delete chunks that no longer exist (e.g., sections removed)
				for (const oldChunkId of existingChunkIds) {
					if (!newChunkIds.has(oldChunkId)) {
						// Delete chunk embedding first if available
						if (this.vectorRepo) {
							this.vectorRepo.deleteChunkEmbedding(oldChunkId);
						}
						this.chunkRepo.deleteChunk(oldChunkId);
					}
				}
			}
		} catch (error) {
			this.logger?.error(`Indexer: Error indexing ${file.path}:`, error);
		}
	}

	/**
	 * Remove a file from the index.
	 */
	removeFile(path: string): void {
		const note = this.noteRepo.getNoteByPath(path);
		if (note) {
			// Delete chunk embeddings first (before deleting chunks)
			if (this.vectorRepo) {
				this.vectorRepo.deleteChunkEmbeddingsByNoteId(note.id);
			}

			// Delete chunks (if available)
			if (this.chunkRepo) {
				this.chunkRepo.deleteChunksByNoteId(note.id);
			}

			// Delete the note
			this.noteRepo.deleteNoteByPath(path);
			this.logger?.debug(`Indexer: Removed ${path} from index`);
		}
	}

	/**
	 * Handle file rename - preserves note ID and embedding.
	 */
	private async handleRenameFile(oldPath: string, file: TFile): Promise<void> {
		const existingNote = this.noteRepo.getNoteByPath(oldPath);

		if (existingNote) {
			// Read new content
			const content = await this.app.vault.cachedRead(file);
			const contentHash = await sha256(content);

			// Check if content changed during rename (unlikely but possible)
			if (existingNote.contentHash === contentHash) {
				// Just a path change, update only the path (preserves embedding)
				const updated = this.noteRepo.updateFilePath(oldPath, file.path);
				if (updated) {
					this.logger?.debug(`Indexer: Renamed ${oldPath} -> ${file.path} (embedding preserved)`);
					return;
				}
			}

			// Content also changed, need to re-index but keep the same ID
			const { title, tags, links } = this.extractMetadata(file, content);
			this.noteRepo.upsertNote({
				id: existingNote.id, // Keep the same ID to preserve embedding reference
				filePath: file.path,
				title,
				contentHash,
			});

			// Update tags and links
			if (this.metadataRepo) {
				this.metadataRepo.setTagsForNote(existingNote.id, tags);
				this.metadataRepo.setLinksForNote(existingNote.id, links);
			}

			this.logger?.debug(`Indexer: Renamed and updated ${oldPath} -> ${file.path}`);
		} else {
			// File wasn't indexed before, index it now
			await this.indexFile(file);
			this.logger?.debug(`Indexer: Indexed new file (from rename): ${file.path}`);
		}
	}

	/**
	 * Extract metadata (title, tags, and links) from file using MarkdownParser and Obsidian's metadataCache.
	 * Title priority: frontmatter title > first H1 > filename
	 * Tags: frontmatter tags + inline #tags (via Obsidian API)
	 * Links: [[wikilinks]] parsed from content, resolved to note IDs
	 */
	private extractMetadata(file: TFile, content: string): {
		title: string;
		tags: string[];
		links: Array<{ toText: string; toNoteId: string | null }>;
	} {
		// Use MarkdownParser for basic metadata extraction
		const cache = this.app.metadataCache.getFileCache(file);
		const parsedMetadata = this.markdownParser.extractMetadataFromCache(file, content, cache);

		// Resolve links to note IDs
		const resolvedLinks: Array<{ toText: string; toNoteId: string | null }> = parsedMetadata.links.map((link) => {
			// Try to resolve the link to a note
			const resolvedFile = this.app.metadataCache.getFirstLinkpathDest(
				link.toText,
				file.path
			);
			const toNoteId = resolvedFile
				? this.noteRepo.getNoteByPath(resolvedFile.path)?.id ?? null
				: null;

			return {
				toText: link.toText,
				toNoteId,
			};
		});

		return {
			title: parsedMetadata.title,
			tags: parsedMetadata.tags,
			links: resolvedLinks,
		};
	}

	/**
	 * Generate a unique note ID from file path.
	 */
	private generateNoteId(filePath: string): string {
		// Use a simple hash of the path as ID
		// This ensures the same file always gets the same ID
		let hash = 0;
		for (let i = 0; i < filePath.length; i++) {
			const char = filePath.charCodeAt(i);
			hash = ((hash << 5) - hash) + char;
			hash = hash & hash; // Convert to 32bit integer
		}
		return `note_${Math.abs(hash).toString(36)}`;
	}

	/**
	 * Generate a unique chunk ID from note ID and chunk index.
	 */
	private generateChunkId(noteId: string, index: number, startLine: number): string {
		// Combine note ID with index and start line for uniqueness
		const combined = `${noteId}_${index}_${startLine}`;
		let hash = 0;
		for (let i = 0; i < combined.length; i++) {
			const char = combined.charCodeAt(i);
			hash = ((hash << 5) - hash) + char;
			hash = hash & hash;
		}
		return `chunk_${Math.abs(hash).toString(36)}`;
	}

	/**
	 * Remove notes that no longer exist in the vault.
	 * Uses batch operations for better performance.
	 */
	private async cleanupDeletedFiles(currentFiles: TFile[]): Promise<void> {
		const currentPaths = new Set(currentFiles.map((f) => f.path));
		const indexedPaths = this.noteRepo.getAllFilePaths();

		// Collect paths to delete
		const pathsToDelete = indexedPaths.filter((path) => !currentPaths.has(path));

		if (pathsToDelete.length === 0) return;

		this.logger?.debug(`Indexer: Cleaning up ${pathsToDelete.length} deleted files`);

		// Get note IDs for the paths to delete (needed for embedding/chunk cleanup)
		const pathToIdMap = this.noteRepo.getNoteIdsByPaths(pathsToDelete);
		const noteIdsToDelete = Array.from(pathToIdMap.values());

		// Batch delete chunk embeddings first (if available)
		if (this.vectorRepo) {
			for (const noteId of noteIdsToDelete) {
				this.vectorRepo.deleteChunkEmbeddingsByNoteId(noteId);
			}
		}

		// Batch delete chunks (if available)
		if (this.chunkRepo) {
			for (const noteId of noteIdsToDelete) {
				this.chunkRepo.deleteChunksByNoteId(noteId);
			}
		}

		// Batch delete notes
		this.noteRepo.deleteNotesByPaths(pathsToDelete);
	}

	/**
	 * Get indexing statistics.
	 */
	getStats(): { totalNotes: number; totalEmbeddings: number; pendingEmbeddings: number } {
		if (!this.vectorRepo) {
			const total = this.noteRepo.getAllNotes().length;
			return { totalNotes: total, totalEmbeddings: 0, pendingEmbeddings: total };
		}
		const counts = this.vectorRepo.getEmbeddingCounts();
		return {
			totalNotes: counts.total,
			totalEmbeddings: counts.embedded,
			pendingEmbeddings: counts.pending,
		};
	}

	isCurrentlyIndexing(): boolean {
		return this.isIndexing;
	}
}
