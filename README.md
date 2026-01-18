# Idea Finder

> Semantic search and similar notes discovery for Obsidian, powered by AI embeddings.

[![GitHub release](https://img.shields.io/github/v/release/skynocover/obsidian-idea-finder)](https://github.com/skynocover/obsidian-idea-finder/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Features

**Hybrid Search** - Combines keyword search with AI-powered semantic search for smarter results. Find notes by meaning, not just exact words.

**Similar Notes** - Discover related notes in a sidebar panel. Great for exploring connections you didn't know existed.

**Content Chunking** - Notes are split by headings for more precise search results. Find the exact section you need.

**Real-time Indexing** - Automatically indexes new and modified notes. Your search is always up to date.

**Offline Support** - Keyword search works without internet. Semantic features require API connectivity.

**CJK Support** - Full support for Chinese, Japanese, and Korean text.

## Screenshots

<!-- TODO: Add screenshots -->
<!-- ![Search Modal](screenshots/search.png) -->
<!-- ![Similar Notes](screenshots/similar-notes.png) -->

## Installation

### From Obsidian Community Plugins (Recommended)

1. Open Obsidian Settings
2. Go to Community Plugins → Browse
3. Search for "Idea Finder"
4. Click Install, then Enable

### Manual Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/skynocover/obsidian-idea-finder/releases)
2. Create folder: `<vault>/.obsidian/plugins/idea-finder/`
3. Copy the downloaded files into the folder
4. Reload Obsidian
5. Enable the plugin in Settings → Community Plugins

## Quick Start

### 1. Open Search

- Click the search icon in the left ribbon, or
- Press `Cmd/Ctrl + P` → "Idea Finder: Search notes"

### 2. Enable Semantic Search (Optional)

For AI-powered semantic search and similar notes:

1. Get a free API key from [jina.ai](https://jina.ai/)
2. Open plugin settings → Enter your API key
3. Click "Generate Chunk Embeddings"

Without an API key, the plugin works with keyword search only.

## Usage

### Search Modes

| Mode | Description | Requires API |
|------|-------------|--------------|
| Keyword | Traditional text search with fuzzy matching | No |
| Semantic | AI-powered meaning-based search | Yes |
| Hybrid | Combines both for best results (default) | Yes |

### Adjusting Search Balance

In settings, adjust the keyword/semantic weight ratio:
- **Higher keyword weight** → Better for exact matches
- **Higher semantic weight** → Better for conceptual similarity

Default: 30% keyword, 70% semantic

### Search Ranking Weights

Fine-tune how keyword results are ranked with these multipliers:

| Weight | Effect |
|--------|--------|
| Title | Boost notes where query appears in title |
| Backlink | Boost notes with more incoming links |
| Tag | Boost notes with matching tags |

These weights only affect keyword search scores before merging with semantic scores. Semantic ranking remains pure similarity-based.

### Similar Notes Panel

- Opens automatically in the right sidebar
- Shows notes similar to your current note
- Click any result to open it
- Adjust similarity threshold in settings

## Commands

| Command | Description |
|---------|-------------|
| `Search notes` | Open the search modal |
| `Show similar notes` | Open similar notes panel |
| `Rebuild index` | Re-scan all markdown files |
| `Generate embeddings` | Create embeddings for semantic search |

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| Jina API Key | Required for semantic features | - |
| Keyword Weight | Balance between search modes | 30% |
| Similarity Threshold | Minimum similarity for related notes | 30% |
| Title Weight | Boost for title matches (keyword only) | 2.0 |
| Backlink Weight | Boost per incoming link (keyword only) | 1.5 |
| Tag Weight | Boost per matching tag (keyword only) | 1.0 |
| Auto-maintain Embeddings | Regenerate embeddings on file changes | On |
| Folder Filter | Include/exclude specific folders | - |

## Privacy & Data

- **Local storage**: All data stored in your vault at `.obsidian/plugins/idea-finder/`
- **API calls**: Only note content is sent to Jina AI when generating embeddings
- **No telemetry**: No usage data is collected

## Troubleshooting

### "No embeddings found"

1. Configure your Jina API key in settings
2. Click "Generate Chunk Embeddings"
3. Wait for the process to complete

### Semantic search not working

1. Check your internet connection
2. Verify API key is correct
3. Ensure embeddings are generated

### Database errors

The plugin auto-recovers from corruption. If issues persist:

1. Close Obsidian
2. Delete `.obsidian/plugins/idea-finder/index.db`
3. Restart Obsidian (rebuilds automatically)

## Development

```bash
# Clone the repository
git clone https://github.com/skynocover/obsidian-idea-finder.git
cd obsidian-idea-finder

# Install dependencies
npm install

# Set your vault path
export OBSIDIAN_VAULT="$HOME/path/to/your/vault"

# Link plugin to vault
npm run setup

# Start development (watch mode)
npm run dev
```

## Technical Stack

- **Database**: sql.js (SQLite in WebAssembly)
- **Keyword Search**: MiniSearch with BM25 ranking
- **Embeddings**: Jina AI (`jina-embeddings-v3`, 1024 dimensions)
- **Similarity**: Cosine similarity

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

## License

[MIT](LICENSE)

## Acknowledgments

- [Obsidian](https://obsidian.md/) for the amazing note-taking app
- [Jina AI](https://jina.ai/) for embedding API
- [sql.js](https://sql.js.org/) for SQLite in the browser
- [MiniSearch](https://lucaong.github.io/minisearch/) for full-text search
