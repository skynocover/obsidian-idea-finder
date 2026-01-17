import { debounce, TFile, type App } from "obsidian";
import type { EmbeddingService, EmbeddingProgress } from "./EmbeddingService";
import type { VectorRepository } from "../database/repositories/VectorRepository";
import type { NoteRepository } from "../database/repositories/NoteRepository";
import type { ChunkRepository } from "../database/repositories/ChunkRepository";
import { showInfo, showProgress, showSuccess, showWarning } from "../utils/notice";
import { sleep } from "../utils/vector";
import type { Logger } from "../utils/Logger";

/**
 * Maintenance task for tracking embedding regeneration.
 */
export interface MaintenanceTask {
	noteId: string;
	filePath: string;
	reason: "stale" | "new" | "modified";
	priority: "high" | "normal" | "low";
	queuedAt: number;
}

/**
 * Maintenance status for UI display.
 */
export interface MaintenanceStatus {
	isRunning: boolean;
	pendingTasks: number;
	processedTasks: number;
	totalTasks: number;
	currentTask: MaintenanceTask | null;
	lastRunAt: number | null;
	error: string | null;
}

/**
 * Configuration for maintenance behavior.
 */
export interface MaintenanceConfig {
	/** Whether auto-maintenance is enabled */
	enabled: boolean;
	/** Minimum delay before processing changes (ms) */
	debounceDelayMs: number;
	/** Interval for periodic stale check (ms), 0 to disable */
	periodicCheckIntervalMs: number;
	/** Maximum tasks to process per batch */
	batchSize: number;
	/** Delay between batches (ms) */
	batchDelayMs: number;
	/** Whether to show notifications */
	showNotifications: boolean;
}

const DEFAULT_CONFIG: MaintenanceConfig = {
	enabled: true,
	debounceDelayMs: 5000, // 5 seconds after last change
	periodicCheckIntervalMs: 300000, // 5 minutes
	batchSize: 10,
	batchDelayMs: 1000,
	showNotifications: true,
};

/**
 * Service for automatic embedding maintenance.
 * Detects stale embeddings and regenerates them in the background.
 */
export class EmbeddingMaintenanceService {
	private config: MaintenanceConfig;
	private taskQueue: Map<string, MaintenanceTask> = new Map();
	private isProcessing = false;
	private abortRequested = false;
	private processedCount = 0;
	private totalCount = 0;
	private currentTask: MaintenanceTask | null = null;
	private lastRunAt: number | null = null;
	private lastError: string | null = null;
	private periodicCheckInterval: ReturnType<typeof setInterval> | null = null;
	private logger: Logger | null;

	// Debounced processor
	private processQueueDebounced: ReturnType<typeof debounce>;

	// Callbacks
	private onStatusChange?: (status: MaintenanceStatus) => void;

	constructor(
		private app: App,
		private embeddingService: EmbeddingService,
		private vectorRepo: VectorRepository,
		private noteRepo: NoteRepository,
		private chunkRepo: ChunkRepository | null,
		private getApiKey: () => string,
		private saveDb: () => Promise<void>,
		config: Partial<MaintenanceConfig> = {},
		logger: Logger | null = null
	) {
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.logger = logger;

		// Initialize debounced processor
		this.processQueueDebounced = debounce(
			() => this.processQueue(),
			this.config.debounceDelayMs,
			true
		);
	}

	/**
	 * Start the maintenance service.
	 */
	start(): void {
		if (!this.config.enabled) {
			this.logger?.debug("EmbeddingMaintenance: Disabled, not starting");
			return;
		}

		this.logger?.info("EmbeddingMaintenance: Starting...");

		// Initial stale check
		this.checkForStaleEmbeddings();

		// Start periodic check if configured
		if (this.config.periodicCheckIntervalMs > 0) {
			this.periodicCheckInterval = setInterval(
				() => this.checkForStaleEmbeddings(),
				this.config.periodicCheckIntervalMs
			);
		}
	}

	/**
	 * Stop the maintenance service.
	 */
	stop(): void {
		this.logger?.info("EmbeddingMaintenance: Stopping...");

		// Clear periodic check
		if (this.periodicCheckInterval) {
			clearInterval(this.periodicCheckInterval);
			this.periodicCheckInterval = null;
		}

		// Abort any running processing
		this.abortRequested = true;
	}

	/**
	 * Update configuration.
	 */
	setConfig(config: Partial<MaintenanceConfig>): void {
		this.config = { ...this.config, ...config };

		// Reinitialize debounced processor with new delay
		this.processQueueDebounced = debounce(
			() => this.processQueue(),
			this.config.debounceDelayMs,
			true
		);

		// Update periodic check interval
		if (this.periodicCheckInterval) {
			clearInterval(this.periodicCheckInterval);
			this.periodicCheckInterval = null;
		}

		if (this.config.enabled && this.config.periodicCheckIntervalMs > 0) {
			this.periodicCheckInterval = setInterval(
				() => this.checkForStaleEmbeddings(),
				this.config.periodicCheckIntervalMs
			);
		}
	}

	/**
	 * Set status change callback.
	 */
	setOnStatusChange(callback: (status: MaintenanceStatus) => void): void {
		this.onStatusChange = callback;
	}

	/**
	 * Get current maintenance status.
	 */
	getStatus(): MaintenanceStatus {
		return {
			isRunning: this.isProcessing,
			pendingTasks: this.taskQueue.size,
			processedTasks: this.processedCount,
			totalTasks: this.totalCount,
			currentTask: this.currentTask,
			lastRunAt: this.lastRunAt,
			error: this.lastError,
		};
	}

	/**
	 * Notify a file has been modified.
	 * Called by IndexerService when files change.
	 */
	notifyFileModified(file: TFile, changeSize: "small" | "large" = "small"): void {
		if (!this.config.enabled) return;

		const note = this.noteRepo.getNoteByPath(file.path);
		if (!note) return;

		// Determine priority based on change size
		const priority = changeSize === "large" ? "high" : "normal";

		this.addTask({
			noteId: note.id,
			filePath: file.path,
			reason: "modified",
			priority,
			queuedAt: Date.now(),
		});
	}

	/**
	 * Notify a new file has been created.
	 */
	notifyFileCreated(file: TFile): void {
		if (!this.config.enabled) return;

		const note = this.noteRepo.getNoteByPath(file.path);
		if (!note) return;

		this.addTask({
			noteId: note.id,
			filePath: file.path,
			reason: "new",
			priority: "normal",
			queuedAt: Date.now(),
		});
	}

	/**
	 * Manually trigger a stale embedding check.
	 */
	checkForStaleEmbeddings(): void {
		if (!this.config.enabled) return;
		if (!this.getApiKey()) return; // No API key, skip

		this.logger?.debug("EmbeddingMaintenance: Checking for stale embeddings...");

		// Get notes needing embedding (stale or missing)
		const staleNotes = this.vectorRepo.getNotesNeedingEmbedding();

		let added = 0;
		for (const note of staleNotes) {
			// Skip if already in queue
			if (this.taskQueue.has(note.id)) continue;

			this.taskQueue.set(note.id, {
				noteId: note.id,
				filePath: note.filePath,
				reason: "stale",
				priority: "low",
				queuedAt: Date.now(),
			});
			added++;
		}

		if (added > 0) {
			this.logger?.info(`EmbeddingMaintenance: Found ${added} stale embeddings`);
			this.totalCount = this.taskQueue.size;
			this.notifyStatusChange();
			this.processQueueDebounced();
		}
	}

	/**
	 * Force process all pending tasks immediately.
	 */
	async processNow(): Promise<{ success: number; failed: number }> {
		return this.processQueue(true);
	}

	/**
	 * Clear all pending tasks.
	 */
	clearQueue(): void {
		this.taskQueue.clear();
		this.processedCount = 0;
		this.totalCount = 0;
		this.notifyStatusChange();
	}

	/**
	 * Add a task to the queue.
	 */
	private addTask(task: MaintenanceTask): void {
		// Update existing task if higher priority
		const existing = this.taskQueue.get(task.noteId);
		if (existing) {
			const priorityOrder = { high: 0, normal: 1, low: 2 };
			if (priorityOrder[task.priority] < priorityOrder[existing.priority]) {
				this.taskQueue.set(task.noteId, task);
			}
		} else {
			this.taskQueue.set(task.noteId, task);
			this.totalCount++;
		}

		this.notifyStatusChange();
		this.processQueueDebounced();
	}

	/**
	 * Process the task queue.
	 */
	private async processQueue(immediate = false): Promise<{ success: number; failed: number }> {
		if (this.isProcessing) {
			this.logger?.debug("EmbeddingMaintenance: Already processing");
			return { success: 0, failed: 0 };
		}

		if (this.taskQueue.size === 0) {
			return { success: 0, failed: 0 };
		}

		const apiKey = this.getApiKey();
		if (!apiKey) {
			this.logger?.debug("EmbeddingMaintenance: No API key configured");
			return { success: 0, failed: 0 };
		}

		this.isProcessing = true;
		this.abortRequested = false;
		this.lastError = null;
		this.notifyStatusChange();

		let success = 0;
		let failed = 0;

		if (this.config.showNotifications && this.taskQueue.size > 5) {
			showProgress(`Updating ${this.taskQueue.size} embeddings...`);
		}

		try {
			// Sort tasks by priority
			const tasks = Array.from(this.taskQueue.values()).sort((a, b) => {
				const priorityOrder = { high: 0, normal: 1, low: 2 };
				return priorityOrder[a.priority] - priorityOrder[b.priority];
			});

			// Process in batches
			for (let i = 0; i < tasks.length; i += this.config.batchSize) {
				if (this.abortRequested) {
					this.logger?.info("EmbeddingMaintenance: Aborted");
					break;
				}

				const batch = tasks.slice(i, i + this.config.batchSize);

				for (const task of batch) {
					if (this.abortRequested) break;

					this.currentTask = task;
					this.notifyStatusChange();

					try {
						// Read file content
						const file = this.app.vault.getAbstractFileByPath(task.filePath);
						if (!(file instanceof TFile)) {
							// File no longer exists, remove from queue
							this.taskQueue.delete(task.noteId);
							continue;
						}

						const content = await this.app.vault.cachedRead(file);
						const note = this.noteRepo.getNoteByPath(task.filePath);

						if (!note) {
							this.taskQueue.delete(task.noteId);
							continue;
						}

						// Generate embedding for this note
						const embedding = await this.embeddingService.embedSingle(content);

						// Save embedding
						this.vectorRepo.upsertNoteEmbedding(note.id, embedding, note.contentHash);

						// Remove from queue
						this.taskQueue.delete(task.noteId);
						this.processedCount++;
						success++;
					} catch (error) {
						this.logger?.error(`EmbeddingMaintenance: Failed to process ${task.filePath}:`, error);
						this.taskQueue.delete(task.noteId);
						failed++;

						// Stop on auth/quota errors
						if (error instanceof Error) {
							const msg = error.message.toLowerCase();
							if (msg.includes("api key") || msg.includes("quota") || msg.includes("401") || msg.includes("402")) {
								this.lastError = error.message;
								break;
							}
						}
					}
				}

				// Save database after each batch
				await this.saveDb();

				// Delay between batches (unless immediate)
				if (!immediate && i + this.config.batchSize < tasks.length && !this.abortRequested) {
					await sleep(this.config.batchDelayMs);
				}
			}

			this.lastRunAt = Date.now();

			if (this.config.showNotifications && (success > 0 || failed > 0)) {
				if (failed === 0) {
					showSuccess(`Updated ${success} embeddings`);
				} else {
					showWarning(`Embeddings: ${success} updated, ${failed} failed`);
				}
			}
		} catch (error) {
			this.logger?.error("EmbeddingMaintenance: Error processing queue:", error);
			this.lastError = error instanceof Error ? error.message : "Unknown error";
		} finally {
			this.isProcessing = false;
			this.currentTask = null;
			this.notifyStatusChange();
		}

		return { success, failed };
	}

	/**
	 * Notify status change to listener.
	 */
	private notifyStatusChange(): void {
		this.onStatusChange?.(this.getStatus());
	}

}
