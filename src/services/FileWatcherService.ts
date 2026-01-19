import { TFile, TAbstractFile, type App, type EventRef, debounce } from "obsidian";
import type { FolderFilterSettings } from "../settings";
import type { Logger } from "../utils/Logger";
import { shouldFilterPath } from "../utils/path";

export type FileChangeType = "create" | "modify" | "delete" | "rename";

export interface FileChangeEvent {
	type: FileChangeType;
	file?: TFile;
	path: string;
	oldPath?: string; // For rename operations
}

export interface FileWatcherCallbacks {
	onFileChange?: (event: FileChangeEvent) => void;
	onBatchReady?: (events: FileChangeEvent[]) => void;
}

export interface FileWatcherOptions {
	getFolderFilter: () => FolderFilterSettings;
	debounceMs?: number;
}

/**
 * FileWatcherService - Only responsible for watching file system events.
 * Separates concerns from IndexerService which handles the actual indexing logic.
 */
export class FileWatcherService {
	private app: App;
	private callbacks: FileWatcherCallbacks;
	private options: FileWatcherOptions;
	private eventRefs: EventRef[] = [];
	private logger: Logger | null;

	// Pending changes queue for batching
	private pendingChanges = new Map<string, FileChangeEvent>();
	private processBatchDebounced: ReturnType<typeof debounce>;

	constructor(
		app: App,
		callbacks: FileWatcherCallbacks = {},
		options: FileWatcherOptions = { getFolderFilter: () => ({ folders: [] }) },
		logger: Logger | null = null
	) {
		this.app = app;
		this.callbacks = callbacks;
		this.options = options;
		this.logger = logger;

		const debounceMs = this.options.debounceMs ?? 300;
		this.processBatchDebounced = debounce(
			() => this.processPendingBatch(),
			debounceMs,
			true
		);
	}

	/**
	 * Check if a file path should be filtered out based on folder filter settings.
	 */
	private isPathFiltered(filePath: string): boolean {
		return shouldFilterPath(filePath, this.options.getFolderFilter());
	}

	/**
	 * Queue a file change event for batched processing.
	 */
	private queueChange(event: FileChangeEvent): void {
		this.pendingChanges.set(event.path, event);
		this.processBatchDebounced();

		// Also call immediate callback if registered
		this.callbacks.onFileChange?.(event);
	}

	/**
	 * Process all pending changes as a batch.
	 */
	private processPendingBatch(): void {
		if (this.pendingChanges.size === 0) return;

		const events = Array.from(this.pendingChanges.values());
		this.pendingChanges.clear();

		this.logger?.debug(`FileWatcher: Processing batch of ${events.length} events`);
		this.callbacks.onBatchReady?.(events);
	}

	/**
	 * Start listening to file changes.
	 */
	startWatching(): void {
		this.logger?.info("FileWatcher: Starting file watcher...");

		// Watch for file creation
		this.eventRefs.push(
			this.app.vault.on("create", (file: TAbstractFile) => {
				if (file instanceof TFile && file.extension === "md") {
					if (this.isPathFiltered(file.path)) {
						this.logger?.debug(`FileWatcher: Skipping filtered file: ${file.path}`);
						return;
					}
					this.logger?.debug(`FileWatcher: File created: ${file.path}`);
					this.queueChange({ type: "create", file, path: file.path });
				}
			})
		);

		// Watch for file modification
		this.eventRefs.push(
			this.app.vault.on("modify", (file: TAbstractFile) => {
				if (file instanceof TFile && file.extension === "md") {
					if (this.isPathFiltered(file.path)) {
						return;
					}
					this.logger?.debug(`FileWatcher: File modified: ${file.path}`);
					this.queueChange({ type: "modify", file, path: file.path });
				}
			})
		);

		// Watch for file deletion
		this.eventRefs.push(
			this.app.vault.on("delete", (file: TAbstractFile) => {
				if (file instanceof TFile && file.extension === "md") {
					this.logger?.debug(`FileWatcher: File deleted: ${file.path}`);
					this.queueChange({ type: "delete", path: file.path });
				}
			})
		);

		// Watch for file rename
		this.eventRefs.push(
			this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
				if (file instanceof TFile && file.extension === "md") {
					this.logger?.debug(`FileWatcher: File renamed: ${oldPath} -> ${file.path}`);

					const oldFiltered = this.isPathFiltered(oldPath);
					const newFiltered = this.isPathFiltered(file.path);

					if (oldFiltered && newFiltered) {
						// Both filtered, ignore
						return;
					} else if (oldFiltered && !newFiltered) {
						// Moving from filtered to non-filtered, treat as create
						this.queueChange({ type: "create", file, path: file.path });
					} else if (!oldFiltered && newFiltered) {
						// Moving from non-filtered to filtered, treat as delete
						this.queueChange({ type: "delete", path: oldPath });
					} else {
						// Normal rename
						this.queueChange({
							type: "rename",
							file,
							path: file.path,
							oldPath,
						});
					}
				}
			})
		);

		this.logger?.info("FileWatcher: File watcher started");
	}

	/**
	 * Stop listening to file changes.
	 */
	stopWatching(): void {
		for (const ref of this.eventRefs) {
			this.app.vault.offref(ref);
		}
		this.eventRefs = [];
		this.pendingChanges.clear();
		this.logger?.info("FileWatcher: File watcher stopped");
	}

	/**
	 * Check if currently watching.
	 */
	isWatching(): boolean {
		return this.eventRefs.length > 0;
	}

	/**
	 * Get number of pending changes.
	 */
	getPendingCount(): number {
		return this.pendingChanges.size;
	}
}
