import { Plugin, WorkspaceLeaf, MarkdownView, TFile } from "obsidian";
import { IdeaFinderSettingTab, type IdeaFinderSettings, DEFAULT_SETTINGS } from "./settings";
import { DatabaseManager } from "./database/DatabaseManager";
import { NoteRepository } from "./database/repositories/NoteRepository";
import { VectorRepository } from "./database/repositories/VectorRepository";
import { MetadataRepository } from "./database/repositories/MetadataRepository";
import { ChunkRepository } from "./database/repositories/ChunkRepository";
import { IndexerService } from "./services/IndexerService";
import { FileWatcherService, type FileChangeEvent } from "./services/FileWatcherService";
import { TextSearchService } from "./services/TextSearchService";
import { EmbeddingService } from "./services/EmbeddingService";
import { VectorService } from "./services/VectorService";
import { SearchWeightService } from "./services/SearchWeightService";
import { SearchHistoryService } from "./services/SearchHistoryService";
import { SearchModal } from "./ui/SearchModal";
import { SimilarNotesView, SIMILAR_NOTES_VIEW_TYPE } from "./ui/SimilarNotesView";
import { Logger } from "./utils/Logger";
import { showSuccess, showError, showWarning, showInfo, showProgress } from "./utils/notice";
import { errorHandler } from "./services/ErrorHandler";

export default class IdeaFinderPlugin extends Plugin {
	settings: IdeaFinderSettings;
	dbManager: DatabaseManager;
	noteRepo: NoteRepository;
	vectorRepo: VectorRepository;
	metadataRepo: MetadataRepository;
	chunkRepo: ChunkRepository;
	indexerService: IndexerService;
	fileWatcherService: FileWatcherService;
	textSearchService: TextSearchService;
	embeddingService: EmbeddingService;
	vectorService: VectorService;
	searchWeightService: SearchWeightService;
	searchHistoryService: SearchHistoryService;
	logger: Logger;
	private settingTab: IdeaFinderSettingTab;
	private indexingStatusBarItem: HTMLElement | null = null;

	async onload() {
		// Initialize logger
		this.logger = new Logger();
		this.logger.info("Idea Finder: Loading plugin...");

		// Initialize error handler with logger
		errorHandler.setLogger(this.logger);

		// Load settings
		await this.loadSettings();

		// Initialize database
		this.dbManager = new DatabaseManager(this.app, this.logger);

		try {
			await this.dbManager.initialize();

			// Initialize repositories
			this.noteRepo = new NoteRepository(() => this.dbManager.getDb());
			this.vectorRepo = new VectorRepository(() => this.dbManager.getDb());
			this.metadataRepo = new MetadataRepository(() => this.dbManager.getDb());
			this.chunkRepo = new ChunkRepository(() => this.dbManager.getDb());

			// Initialize services
			this.textSearchService = new TextSearchService(
				this.noteRepo,
				this.chunkRepo,
				this.app,
				this.logger
			);
			await this.textSearchService.initialize();

			this.embeddingService = new EmbeddingService(
				this.app,
				this.vectorRepo,
				this.settings.jinaApiKey,
				this.chunkRepo,
				this.logger
			);

			this.vectorService = new VectorService(
				this.vectorRepo,
				this.embeddingService,
				this.logger
			);

			// Initialize search weight service
			this.searchWeightService = new SearchWeightService(
				this.noteRepo,
				this.metadataRepo,
				() => this.settings.searchWeights
			);

			// Initialize search history service
			this.searchHistoryService = new SearchHistoryService(
				() => this.loadData(),
				(data) => this.saveData(data),
				50,
				"searchHistory",
				this.logger
			);
			await this.searchHistoryService.load();

			// Initialize indexer service (indexing logic only)
			this.indexerService = new IndexerService(
				this.app,
				this.noteRepo,
				async () => await this.dbManager.save(),
				{
					onProgress: (current, total) => {
						// Update status bar progress indicator
						this.updateIndexingProgress(current, total);
						if (current % 50 === 0 || current === total) {
							this.logger.debug(`Indexing: ${current}/${total}`);
						}
					},
					onProgressivePhase: (phase, current, total) => {
						const phaseLabel = phase === "priority" ? "Priority" : "Background";
						this.updateIndexingProgress(current, total, phaseLabel);
					},
					onComplete: async (total) => {
						this.hideIndexingProgress();
						showSuccess(`Idea Finder: Indexed ${total} notes`);
						await this.textSearchService.rebuild();
					},
					onFileIndexed: async (path) => {
						const note = this.noteRepo.getNoteByPath(path);
						if (note) {
							// Update text search index with new chunks
							this.textSearchService.addOrUpdateNote(
								note.id,
								note.title,
								note.filePath
							);
						}
					},
				},
				{
					getFolderFilter: () => this.settings.folderFilter,
					getChunkingOptions: () => this.settings.chunkingOptions,
				},
				this.metadataRepo,
				this.chunkRepo,
				this.vectorRepo,
				this.logger
			);

			// Initialize file watcher service (file watching only)
			this.fileWatcherService = new FileWatcherService(
				this.app,
				{
					onFileChange: (event) => {
						this.logger.debug(`File ${event.type}: ${event.path}`);
					},
					onBatchReady: async (events: FileChangeEvent[]) => {
						// Process batch through indexer service
						await this.indexerService.processFileChangeEvents(events);
						// Handle text search updates for deletions
						for (const event of events) {
							if (event.type === "delete") {
								const note = this.noteRepo.getNoteByPath(event.path);
								if (note) {
									this.textSearchService.removeAllForNote(note.id);
								}
							}
						}
					},
				},
				{
					getFolderFilter: () => this.settings.folderFilter,
					debounceMs: 300,
				},
				this.logger
			);

			// Start file watcher
			this.fileWatcherService.startWatching();

			// Auto-index on first load if no notes indexed (uses progressive indexing)
			const stats = this.indexerService.getStats();
			if (stats.totalNotes === 0) {
				setTimeout(async () => {
					showProgress("Idea Finder: Starting initial index...");
					await this.indexerService.indexAllProgressive();
				}, 2000);
			}
		} catch (error) {
			this.logger.error("Idea Finder: Failed to initialize database:", error);
			showError("Idea Finder: Failed to initialize database. Check console for details.");
		}

		// Register Similar Notes view
		this.registerView(SIMILAR_NOTES_VIEW_TYPE, (leaf) => {
			return new SimilarNotesView(
				leaf,
				this.vectorService,
				this.noteRepo,
				this.vectorRepo,
				() => this.settings,
				async () => {
					// Generate embeddings callback
					if (!this.settings.jinaApiKey) {
						showWarning("Please configure your Jina API key in settings");
						return;
					}
					if (this.embeddingService?.isGenerating()) {
						showInfo("Already generating embeddings...");
						return;
					}
					showProgress("Generating embeddings...");
					try {
						const result = await this.embeddingService?.generateAll();
						if (result) {
							showSuccess(`Done: ${result.success} succeeded, ${result.failed} failed`);
							await this.dbManager?.save();
						}
					} catch (error) {
						showError(`Error: ${error instanceof Error ? error.message : "Unknown"}`);
					}
				}
			);
		});

		// Add settings tab
		this.settingTab = new IdeaFinderSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		// Add ribbon icon - opens search modal
		this.addRibbonIcon("search", "Idea Finder Search", () => {
			this.openSearchModal();
		});

		// Add status bar item for Similar Notes (bottom right, easy access)
		const statusBarItem = this.addStatusBarItem();
		statusBarItem.addClass("vibe-similar-status-btn");
		statusBarItem.setText("Similar Notes");
		statusBarItem.onClickEvent(() => {
			this.activateSimilarNotesView();
		});

		// Also add view header action for markdown views
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				this.addSimilarNotesAction(leaf);
			})
		);

		// Add action to current view on load + auto-open Similar Notes view
		this.app.workspace.onLayoutReady(() => {
			const activeLeaf = this.app.workspace.getActiveViewOfType(MarkdownView)?.leaf;
			if (activeLeaf) {
				this.addSimilarNotesAction(activeLeaf);
			}

			// Auto-open Similar Notes view if not already open
			const existingLeaves = this.app.workspace.getLeavesOfType(SIMILAR_NOTES_VIEW_TYPE);
			if (existingLeaves.length === 0) {
				this.activateSimilarNotesView();
			}
		});

		// Register commands
		this.addCommand({
			id: "open-search",
			name: "Search notes",
			callback: () => {
				this.openSearchModal();
			},
		});

		this.addCommand({
			id: "rebuild-index",
			name: "Rebuild index",
			callback: async () => {
				if (this.indexerService) {
					showProgress("Idea Finder: Rebuilding index...");
					await this.indexerService.indexAllProgressive();
				}
			},
		});

		this.addCommand({
			id: "open-similar-notes",
			name: "Show similar notes",
			callback: () => {
				this.activateSimilarNotesView();
			},
		});

		this.addCommand({
			id: "generate-embeddings",
			name: "Generate embeddings",
			callback: async () => {
				if (!this.settings.jinaApiKey) {
					showWarning("Please configure your Jina API key in settings");
					return;
				}
				if (this.embeddingService?.isGenerating()) {
					showInfo("Already generating embeddings...");
					return;
				}
				showProgress("Idea Finder: Generating embeddings...");
				try {
					const result = await this.embeddingService?.generateAll((progress) => {
						if (progress.current % 10 === 0) {
							this.logger.debug(`Embedding progress: ${progress.current}/${progress.total}`);
						}
					});
					if (result) {
						showSuccess(
							`Embeddings complete: ${result.success} succeeded, ${result.failed} failed`
						);
						await this.dbManager?.save();
					}
				} catch (error) {
					showError(`Embedding error: ${error instanceof Error ? error.message : "Unknown"}`);
				}
			},
		});

		this.logger.info("Idea Finder: Plugin loaded successfully!");
	}

	/**
	 * Open the search modal.
	 */
	private openSearchModal(): void {
		if (!this.textSearchService) {
			showError("Idea Finder: Search service not initialized");
			return;
		}

		const modal = new SearchModal(
			this.app,
			this.textSearchService,
			this.vectorService || null,
			{
				keywordWeight: this.settings.keywordWeight,
				semanticWeight: this.settings.semanticWeight,
				searchThreshold: this.settings.searchThreshold,
			},
			async (result) => {
				// Open file and jump to the chunk's start line
				await SearchModal.openFile(this.app, result.filePath, result.startLine);
			},
			this.searchWeightService || null,
			this.searchHistoryService || null,
			this.metadataRepo || null,
			this.logger
		);
		modal.open();
	}

	/**
	 * Add similar notes action button to view header.
	 */
	private addSimilarNotesAction(leaf: WorkspaceLeaf | null): void {
		if (!leaf) return;

		const view = leaf.view;
		if (!(view instanceof MarkdownView)) return;

		// Check if action already exists (avoid duplicates)
		const existingAction = view.containerEl.querySelector(".vibe-similar-action");
		if (existingAction) return;

		// Add action to view header
		const headerEl = view.containerEl.querySelector(".view-header-right-actions");
		if (headerEl) {
			const actionBtn = headerEl.createEl("a", {
				cls: "view-action vibe-similar-action",
				attr: {
					"aria-label": "Similar Notes",
				},
			});
			actionBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"></circle><circle cx="6" cy="6" r="3"></circle><path d="M6 21V9a9 9 0 0 0 9 9"></path></svg>`;
			actionBtn.addEventListener("click", (e) => {
				e.preventDefault();
				this.activateSimilarNotesView();
			});
		}
	}

	/**
	 * Activate the similar notes sidebar view.
	 */
	async activateSimilarNotesView(): Promise<void> {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(SIMILAR_NOTES_VIEW_TYPE);

		if (leaves.length > 0) {
			leaf = leaves[0];
		} else {
			leaf = workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.setViewState({
					type: SIMILAR_NOTES_VIEW_TYPE,
					active: true,
				});
			}
		}

		if (leaf) {
			workspace.revealLeaf(leaf);
		}
	}

	async onunload() {
		this.logger?.info("Idea Finder: Unloading plugin...");

		// Stop file watcher
		if (this.fileWatcherService) {
			this.fileWatcherService.stopWatching();
		}

		// Save and close database
		if (this.dbManager) {
			await this.dbManager.save();
			this.dbManager.close();
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/**
	 * Update the indexing progress indicator in the status bar.
	 */
	private updateIndexingProgress(current: number, total: number, phase?: string): void {
		if (!this.indexingStatusBarItem) {
			this.indexingStatusBarItem = this.addStatusBarItem();
			this.indexingStatusBarItem.addClass("idea-finder-indexing-progress");
		}

		const percent = total > 0 ? Math.round((current / total) * 100) : 0;
		const phaseText = phase ? `[${phase}] ` : "";
		this.indexingStatusBarItem.setText(`${phaseText}Indexing: ${current}/${total} (${percent}%)`);
		this.indexingStatusBarItem.show();
	}

	/**
	 * Hide the indexing progress indicator.
	 */
	private hideIndexingProgress(): void {
		if (this.indexingStatusBarItem) {
			this.indexingStatusBarItem.hide();
		}
	}
}
