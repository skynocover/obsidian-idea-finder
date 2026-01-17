import { ItemView, WorkspaceLeaf, TFile } from "obsidian";
import type { VectorService, SimilarNote } from "../services/VectorService";
import type { NoteRepository } from "../database/repositories/NoteRepository";
import type { VectorRepository } from "../database/repositories/VectorRepository";
import type { IdeaFinderSettings } from "../settings";
import { similarityToPercent } from "../utils/vector";
import { SIMILAR_NOTES_LIMIT } from "../config/constants";

export const SIMILAR_NOTES_VIEW_TYPE = "idea-finder-similar-notes";

export class SimilarNotesView extends ItemView {
	private vectorService: VectorService;
	private noteRepo: NoteRepository;
	private vectorRepo: VectorRepository;
	private getSettings: () => IdeaFinderSettings;
	private onGenerateEmbeddings: () => Promise<void>;
	private statusEl: HTMLElement;

	constructor(
		leaf: WorkspaceLeaf,
		vectorService: VectorService,
		noteRepo: NoteRepository,
		vectorRepo: VectorRepository,
		getSettings: () => IdeaFinderSettings,
		onGenerateEmbeddings: () => Promise<void>
	) {
		super(leaf);
		this.vectorService = vectorService;
		this.noteRepo = noteRepo;
		this.vectorRepo = vectorRepo;
		this.getSettings = getSettings;
		this.onGenerateEmbeddings = onGenerateEmbeddings;
	}

	getViewType(): string {
		return SIMILAR_NOTES_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Similar Notes";
	}

	getIcon(): string {
		return "git-compare";
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1];
		container.empty();
		container.addClass("idea-finder-similar-notes");

		// Header
		const header = container.createEl("div", { cls: "vibe-similar-header" });
		header.createEl("h4", { text: "Similar Notes" });

		// Status area (pending count + embed button)
		this.statusEl = container.createEl("div", { cls: "vibe-similar-status" });
		this.updateStatus();

		// Content area
		this.contentEl = container.createEl("div", { cls: "vibe-similar-content" });

		// Register for active file changes
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.updateView();
			})
		);

		// Register for vault file changes to update pending count
		this.registerEvent(
			this.app.vault.on("create", () => {
				// Delay to allow indexer to process first
				setTimeout(() => this.updateStatus(), 500);
			})
		);
		this.registerEvent(
			this.app.vault.on("modify", () => {
				setTimeout(() => this.updateStatus(), 500);
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", () => {
				setTimeout(() => {
					this.updateStatus();
					this.updateView();
				}, 500);
			})
		);

		// Initial update
		this.updateView();
	}

	private updateStatus(): void {
		if (!this.statusEl) return;
		this.statusEl.empty();

		const counts = this.vectorRepo.getEmbeddingCounts();

		// Only show status when there are pending notes
		if (counts.pending > 0) {
			const statusText = this.statusEl.createEl("span", {
				cls: "vibe-similar-status-text",
			});
			statusText.setText(`${counts.pending} notes need embedding`);

			const embedBtn = this.statusEl.createEl("button", {
				cls: "vibe-similar-embed-btn",
				text: "Generate",
			});
			embedBtn.addEventListener("click", async () => {
				embedBtn.disabled = true;
				embedBtn.setText("Generating...");
				try {
					await this.onGenerateEmbeddings();
					this.updateStatus();
					this.updateView();
				} finally {
					embedBtn.disabled = false;
					embedBtn.setText("Generate");
				}
			});
		}
		// Don't show anything when all notes are embedded
	}

	async onClose(): Promise<void> {
		// Cleanup if needed
	}

	private async updateView(): Promise<void> {
		if (!this.contentEl) return;

		this.contentEl.empty();

		// Get active file
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile || activeFile.extension !== "md") {
			this.contentEl.createEl("p", {
				text: "Open a markdown file to see similar notes",
				cls: "vibe-similar-empty",
			});
			return;
		}

		// Get note from database
		const note = this.noteRepo.getNoteByPath(activeFile.path);
		if (!note) {
			this.contentEl.createEl("p", {
				text: "This note is not indexed yet",
				cls: "vibe-similar-empty",
			});
			return;
		}

		// Check if note has embedding
		if (!this.vectorService.hasEmbedding(note.id)) {
			this.contentEl.createEl("p", {
				text: "No embedding for this note. Generate embeddings in settings.",
				cls: "vibe-similar-empty",
			});
			return;
		}

		// Get similar notes with threshold from settings
		const threshold = this.getSettings().similarityThreshold / 100; // Convert from % to 0-1
		const similarNotes = this.vectorService.getSimilarNotes(note.id, SIMILAR_NOTES_LIMIT, threshold);

		if (similarNotes.length === 0) {
			this.contentEl.createEl("p", {
				text: `No similar notes found (threshold: ${this.getSettings().similarityThreshold}%)`,
				cls: "vibe-similar-empty",
			});
			return;
		}

		// Render similar notes
		const list = this.contentEl.createEl("div", { cls: "vibe-similar-list" });

		for (const similarNote of similarNotes) {
			const item = list.createEl("div", { cls: "vibe-similar-note-item" });

			const titleEl = item.createEl("div", { cls: "vibe-similar-note-title" });
			titleEl.setText(similarNote.title);

			const scoreEl = item.createEl("div", { cls: "vibe-similar-note-score" });
			scoreEl.setText(`${similarityToPercent(similarNote.similarity)}% similar`);

			// Click to open file in vertical split (side by side)
			item.addEventListener("click", async () => {
				const file = this.app.vault.getAbstractFileByPath(similarNote.filePath);
				if (file instanceof TFile) {
					// Open in vertical split (left/right side by side)
					const leaf = this.app.workspace.getLeaf("split", "vertical");
					await leaf.openFile(file);
				}
			});
		}
	}

	/**
	 * Refresh the view externally.
	 */
	refresh(): void {
		this.updateView();
	}
}
