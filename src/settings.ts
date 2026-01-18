import { App, PluginSettingTab, Setting } from "obsidian";
import type IdeaFinderPlugin from "./main";
import type { ChunkingOptions } from "./utils/MarkdownParser";

export const DEFAULT_CHUNKING_OPTIONS: ChunkingOptions = {
	maxHeadingLevel: 2,
};

export interface FolderFilterSettings {
	folders: string[]; // Relative paths from vault root to exclude
}

export interface SearchWeights {
	title: number; // 1.0-5.0, default 2.0, title match importance
	backlink: number; // 0-5.0, default 1.5, more backlinks = higher score
	tag: number; // 0-3.0, default 1.0, tag match bonus
}

export const DEFAULT_SEARCH_WEIGHTS: SearchWeights = {
	title: 2.0,
	backlink: 1.5,
	tag: 1.0,
};

export interface IdeaFinderSettings {
	jinaApiKey: string;
	keywordWeight: number; // 0-1, weight for keyword search
	semanticWeight: number; // 0-1, weight for semantic search
	searchThreshold: number; // Minimum score % to show in search results
	similarityThreshold: number; // Minimum similarity % to show in similar notes
	folderFilter: FolderFilterSettings;
	searchWeights: SearchWeights;
	chunkingOptions: ChunkingOptions;
}

export const DEFAULT_SETTINGS: IdeaFinderSettings = {
	jinaApiKey: "",
	keywordWeight: 0.3,
	semanticWeight: 0.7,
	searchThreshold: 10, // 10% minimum search score
	similarityThreshold: 30, // 30% minimum similarity
	folderFilter: {
		folders: [],
	},
	searchWeights: { ...DEFAULT_SEARCH_WEIGHTS },
	chunkingOptions: { ...DEFAULT_CHUNKING_OPTIONS },
};

export class IdeaFinderSettingTab extends PluginSettingTab {
	plugin: IdeaFinderPlugin;
	private statusContainer: HTMLElement | null = null;

	constructor(app: App, plugin: IdeaFinderPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// Header
		containerEl.createEl("h2", { text: "Idea Finder Settings" });

		// Status Section
		containerEl.createEl("h3", { text: "Status" });
		this.statusContainer = containerEl.createDiv({ cls: "idea-finder-status" });
		this.renderStatus();

		// API Key Section
		containerEl.createEl("h3", { text: "API Configuration" });

		new Setting(containerEl)
			.setName("Jina API Key")
			.setDesc("Enter your Jina AI API key for embeddings (used by Similar Notes)")
			.addText((text) =>
				text
					.setPlaceholder("jina_xxxxxxxxxxxxxxxx")
					.setValue(this.plugin.settings.jinaApiKey)
					.onChange(async (value) => {
						this.plugin.settings.jinaApiKey = value;
						await this.plugin.saveSettings();
						// Update embedding service with new key
						this.plugin.embeddingService?.setApiKey(value);
					})
			);

		// API Key help text
		const apiKeyHelp = containerEl.createEl("p", {
			cls: "setting-item-description",
		});
		apiKeyHelp.innerHTML = `Get your API key from <a href="https://jina.ai/">jina.ai</a>. Required for Similar Notes feature.`;

		// Folder Filter Settings Section
		containerEl.createEl("h3", { text: "Exclude Folders" });

		// Folder list
		const folderSetting = new Setting(containerEl)
			.setName("Folders to Exclude")
			.setDesc("Enter folder paths to exclude from indexing (one per line). Use '/' for root folder files.");

		const textArea = folderSetting.controlEl.createEl("textarea", {
			cls: "vibe-folder-filter-textarea",
			attr: {
				placeholder: "/\nTemplates\nArchive\nDaily Notes",
				rows: "5",
			},
		});
		textArea.style.width = "100%";
		textArea.style.minHeight = "80px";
		textArea.style.resize = "vertical";
		textArea.value = this.plugin.settings.folderFilter.folders.join("\n");
		textArea.addEventListener("change", async () => {
			const folders = textArea.value
				.split("\n")
				.map((f) => f.trim())
				.filter((f) => f.length > 0);
			this.plugin.settings.folderFilter.folders = folders;
			await this.plugin.saveSettings();
		});

		// Help text
		const filterHelp = containerEl.createEl("p", {
			cls: "setting-item-description",
		});
		filterHelp.setText(
			"Note: After changing folder settings, rebuild the index for changes to take effect."
		);

		// Chunking Settings Section
		containerEl.createEl("h3", { text: "Content Chunking" });

		const chunkingHelp = containerEl.createEl("p", {
			cls: "setting-item-description",
		});
		chunkingHelp.setText(
			"Split notes into smaller chunks by headings for more precise search results."
		);

		// Max Heading Level (1-6)
		new Setting(containerEl)
			.setName("Max Heading Level")
			.setDesc("Split at headings up to this level (1 = # only, 2 = # and ##, etc.)")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("1", "# (H1 only)")
					.addOption("2", "## (H1-H2)")
					.addOption("3", "### (H1-H3)")
					.addOption("4", "#### (H1-H4)")
					.addOption("5", "##### (H1-H5)")
					.addOption("6", "###### (H1-H6)")
					.setValue(String(this.plugin.settings.chunkingOptions.maxHeadingLevel))
					.onChange(async (value) => {
						this.plugin.settings.chunkingOptions.maxHeadingLevel = parseInt(value, 10);
						await this.plugin.saveSettings();
					})
			);

		// Chunking help text
		const chunkingNote = containerEl.createEl("p", {
			cls: "setting-item-description",
		});
		chunkingNote.setText(
			"Note: After changing chunking settings, rebuild the index to re-chunk all notes."
		);

		// Similar Notes Settings Section
		containerEl.createEl("h3", { text: "Similar Notes" });

		new Setting(containerEl)
			.setName("Similarity Threshold (%)")
			.setDesc("Minimum similarity percentage to show in similar notes panel (0-100)")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "0";
				text.inputEl.max = "100";
				text.inputEl.style.width = "60px";
				text
					.setPlaceholder("30")
					.setValue(String(this.plugin.settings.similarityThreshold))
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num >= 0 && num <= 100) {
							this.plugin.settings.similarityThreshold = num;
							await this.plugin.saveSettings();
						}
					});
			});

		// Search Settings Section
		containerEl.createEl("h3", { text: "Search Settings" });

		// Weight slider container
		const weightContainer = containerEl.createDiv({ cls: "idea-finder-weight-container" });

		// Weight display
		const weightDisplay = weightContainer.createDiv({ cls: "idea-finder-weight-display" });
		const keywordLabel = weightDisplay.createSpan({ cls: "idea-finder-weight-label keyword" });
		const semanticLabel = weightDisplay.createSpan({ cls: "idea-finder-weight-label semantic" });

		const updateWeightDisplay = () => {
			const kw = Math.round(this.plugin.settings.keywordWeight * 100);
			const sem = Math.round(this.plugin.settings.semanticWeight * 100);
			keywordLabel.setText(`Keyword ${kw}%`);
			semanticLabel.setText(`Semantic ${sem}%`);
		};
		updateWeightDisplay();

		// Slider setting
		new Setting(weightContainer)
			.setName("Search Weight Balance")
			.setDesc("Drag left for more keyword weight, drag right for more semantic weight")
			.addSlider((slider) => {
				slider
					.setLimits(0, 100, 5)
					.setValue(Math.round(this.plugin.settings.semanticWeight * 100))
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.semanticWeight = value / 100;
						this.plugin.settings.keywordWeight = (100 - value) / 100;
						updateWeightDisplay();
						await this.plugin.saveSettings();
					});
				slider.sliderEl.style.width = "100%";
			});

		// Add some styling inline
		weightDisplay.style.display = "flex";
		weightDisplay.style.justifyContent = "space-between";
		weightDisplay.style.marginBottom = "8px";
		weightDisplay.style.fontWeight = "500";
		keywordLabel.style.color = "var(--text-accent)";
		semanticLabel.style.color = "var(--interactive-accent)";

		new Setting(containerEl)
			.setName("Search Threshold (%)")
			.setDesc("Minimum match percentage to show in search results (0-100)")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "0";
				text.inputEl.max = "100";
				text.inputEl.style.width = "60px";
				text
					.setPlaceholder("10")
					.setValue(String(this.plugin.settings.searchThreshold))
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num >= 0 && num <= 100) {
							this.plugin.settings.searchThreshold = num;
							await this.plugin.saveSettings();
						}
					});
			});

		// Search Weights Section
		containerEl.createEl("h3", { text: "Search Ranking Weights" });

		const weightsHelp = containerEl.createEl("p", {
			cls: "setting-item-description",
		});
		weightsHelp.setText(
			"Adjust how search results are ranked. Higher values increase importance. Set to 0 to disable."
		);

		// Title Weight (1.0 - 5.0)
		new Setting(containerEl)
			.setName("Title Weight")
			.setDesc("Boost for title matches (1.0 = no boost, higher = title matches rank higher)")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "1";
				text.inputEl.max = "5";
				text.inputEl.step = "0.1";
				text.inputEl.style.width = "60px";
				text
					.setPlaceholder("2.0")
					.setValue(String(this.plugin.settings.searchWeights.title))
					.onChange(async (value) => {
						const num = parseFloat(value);
						if (!isNaN(num) && num >= 1 && num <= 5) {
							this.plugin.settings.searchWeights.title = num;
							await this.plugin.saveSettings();
						}
					});
			})
			.addButton((button) =>
				button
					.setButtonText("Reset")
					.onClick(async () => {
						this.plugin.settings.searchWeights.title = DEFAULT_SEARCH_WEIGHTS.title;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		// Backlink Weight (0 - 5.0)
		new Setting(containerEl)
			.setName("Backlink Weight")
			.setDesc("Bonus per backlink (0 = disabled, higher = more backlinks rank higher)")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "0";
				text.inputEl.max = "5";
				text.inputEl.step = "0.1";
				text.inputEl.style.width = "60px";
				text
					.setPlaceholder("1.5")
					.setValue(String(this.plugin.settings.searchWeights.backlink))
					.onChange(async (value) => {
						const num = parseFloat(value);
						if (!isNaN(num) && num >= 0 && num <= 5) {
							this.plugin.settings.searchWeights.backlink = num;
							await this.plugin.saveSettings();
						}
					});
			})
			.addButton((button) =>
				button
					.setButtonText("Reset")
					.onClick(async () => {
						this.plugin.settings.searchWeights.backlink = DEFAULT_SEARCH_WEIGHTS.backlink;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		// Tag Weight (0 - 3.0)
		new Setting(containerEl)
			.setName("Tag Match Weight")
			.setDesc("Bonus when query matches note tags (0 = disabled)")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "0";
				text.inputEl.max = "3";
				text.inputEl.step = "0.1";
				text.inputEl.style.width = "60px";
				text
					.setPlaceholder("1.0")
					.setValue(String(this.plugin.settings.searchWeights.tag))
					.onChange(async (value) => {
						const num = parseFloat(value);
						if (!isNaN(num) && num >= 0 && num <= 3) {
							this.plugin.settings.searchWeights.tag = num;
							await this.plugin.saveSettings();
						}
					});
			})
			.addButton((button) =>
				button
					.setButtonText("Reset")
					.onClick(async () => {
						this.plugin.settings.searchWeights.tag = DEFAULT_SEARCH_WEIGHTS.tag;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		// Reset All Weights button
		new Setting(containerEl)
			.setName("Reset All Weights")
			.setDesc("Restore all search ranking weights to default values")
			.addButton((button) =>
				button
					.setButtonText("Reset All")
					.setWarning()
					.onClick(async () => {
						this.plugin.settings.searchWeights = { ...DEFAULT_SEARCH_WEIGHTS };
						await this.plugin.saveSettings();
						this.display();
					})
			);
	}

	private renderStatus(): void {
		if (!this.statusContainer) return;
		this.statusContainer.empty();

		const counts = this.plugin.vectorRepo?.getNoteEmbeddingCounts();

		// Embeddings count
		new Setting(this.statusContainer)
			.setName("Embeddings")
			.setDesc(
				counts
					? `${counts.embedded}/${counts.total} notes`
					: "Not initialized"
			);
	}
}
