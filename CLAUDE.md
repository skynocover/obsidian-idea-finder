# Idea Finder - Obsidian Plugin

An Obsidian plugin for semantic search and similar notes discovery powered by AI embeddings.

**Plugin ID**: `idea-finder`
**Min Obsidian Version**: 1.0.0
**Desktop Only**: Yes (uses sql.js WASM)

## What This Plugin Does

1. **Hybrid Search** - Combines keyword search (MiniSearch) with semantic search (vector embeddings) for smarter note discovery
2. **Similar Notes** - Shows related notes in a sidebar panel based on vector similarity
3. **Content Chunking** - Splits notes by headings for more precise semantic matching
4. **Auto-Indexing** - Watches vault for changes and keeps index up-to-date
5. **Auto-Maintenance** - Automatically regenerates embeddings when notes change

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Obsidian Plugin API |
| Database | sql.js (SQLite compiled to WebAssembly) |
| Full-Text Search | MiniSearch (fuzzy matching, prefix search) |
| Embeddings | Jina AI API (`jina-embeddings-v3`, 1024 dimensions) |
| Build | esbuild (CommonJS output, single `main.js`) |
| Language | TypeScript 5.3+ |

## Project Structure

```
idea-finder/
├── src/
│   ├── main.ts                     # Plugin entry point, lifecycle management
│   ├── settings.ts                 # Plugin settings UI (PluginSettingTab)
│   ├── types.ts                    # Shared TypeScript interfaces
│   │
│   ├── config/
│   │   └── constants.ts            # Centralized magic numbers & config
│   │
│   ├── database/
│   │   ├── DatabaseManager.ts      # SQLite (sql.js WASM) lifecycle
│   │   ├── sql-types.ts            # SQL type definitions
│   │   ├── utils.ts                # Database utilities
│   │   └── repositories/
│   │       ├── NoteRepository.ts   # Note CRUD operations
│   │       ├── VectorRepository.ts # Note-level embedding CRUD
│   │       ├── ChunkRepository.ts  # Chunk CRUD operations
│   │       └── MetadataRepository.ts # Tags & links CRUD
│   │
│   ├── services/
│   │   ├── IndexerService.ts       # Full vault indexing
│   │   ├── FileWatcherService.ts   # Real-time file change detection
│   │   ├── TextSearchService.ts    # Keyword search (MiniSearch)
│   │   ├── EmbeddingService.ts     # Jina AI embedding generation
│   │   ├── VectorService.ts        # Semantic search & similarity
│   │   ├── SearchWeightService.ts  # Search ranking adjustments
│   │   ├── SearchHistoryService.ts # Recent query tracking
│   │   ├── EmbeddingMaintenanceService.ts # Auto-regenerate stale embeddings
│   │   └── ErrorHandler.ts         # Centralized error handling
│   │
│   ├── ui/
│   │   ├── SearchModal.ts          # Hybrid search modal (SuggestModal)
│   │   └── SimilarNotesView.ts     # Sidebar panel (ItemView)
│   │
│   ├── utils/
│   │   ├── Logger.ts               # Structured logging
│   │   ├── notice.ts               # Obsidian Notice utilities
│   │   ├── vector.ts               # Float32Array <-> Uint8Array
│   │   ├── lru-cache.ts            # LRU cache implementation
│   │   ├── MarkdownParser.ts       # Frontmatter & heading extraction
│   │   ├── AdvancedQueryParser.ts  # Search query parsing
│   │   ├── path.ts                 # Path utilities
│   │   └── file.ts                 # File utilities
│   │
│   └── errors/
│       └── index.ts                # Structured error types
│
├── manifest.json                   # Obsidian plugin manifest
├── package.json                    # Dependencies & scripts
├── tsconfig.json                   # TypeScript configuration
├── esbuild.config.mjs              # Build configuration
├── styles.css                      # Plugin styles
└── scripts/
    └── link-plugin.js              # Dev: symlink to vault
```

## Development Commands

```bash
npm install    # Install dependencies
npm run dev    # Watch mode (hot reload with .hotreload)
npm run build  # Production build
npm run setup  # Symlink plugin to Obsidian vault for testing
```

## Database Schema

Storage location: `.obsidian/plugins/idea-finder/index.db`

```sql
-- Notes table (indexed markdown files)
CREATE TABLE notes (
    id TEXT PRIMARY KEY,              -- SHA-256 of file path
    file_path TEXT UNIQUE NOT NULL,   -- Relative path from vault root
    title TEXT NOT NULL,              -- Extracted from frontmatter/H1/filename
    content_hash TEXT NOT NULL,       -- SHA-256 of content (change detection)
    indexed_at INTEGER                -- Unix timestamp
);

-- Tags table (frontmatter + inline #tags)
CREATE TABLE note_tags (
    note_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY (note_id, tag),
    FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
);

-- Links table ([[wikilinks]] between notes)
CREATE TABLE links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_note_id TEXT NOT NULL,
    to_note_id TEXT,                  -- NULL if target doesn't exist
    to_text TEXT NOT NULL,            -- Original link text
    FOREIGN KEY (from_note_id) REFERENCES notes(id) ON DELETE CASCADE
);

-- Note-level embeddings (whole note vectors)
CREATE TABLE embeddings (
    note_id TEXT PRIMARY KEY,
    vector BLOB NOT NULL,             -- Float32Array as binary
    content_hash TEXT NOT NULL,       -- Must match notes.content_hash
    FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
);

-- Chunks table (note sections split by headings)
CREATE TABLE note_chunks (
    id TEXT PRIMARY KEY,              -- SHA-256 of note_id + heading + startLine
    note_id TEXT NOT NULL,
    heading TEXT,                     -- NULL for content before first heading
    heading_level INTEGER,            -- 1 = #, 2 = ##, etc.
    content TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
);

-- Chunk-level embeddings (more precise semantic search)
CREATE TABLE chunk_embeddings (
    chunk_id TEXT PRIMARY KEY,
    vector BLOB NOT NULL,
    content_hash TEXT NOT NULL,
    FOREIGN KEY (chunk_id) REFERENCES note_chunks(id) ON DELETE CASCADE
);
```

**Important**: Note content is NOT stored in the database. Services read content directly from the vault using `app.vault.cachedRead()` to avoid duplication.

## Key Interfaces

```typescript
// src/types.ts
interface Note {
    id: string;
    filePath: string;
    title: string;
    contentHash: string;
    indexedAt: number;
}

interface Chunk {
    id: string;
    noteId: string;
    heading: string | null;
    headingLevel: number | null;
    content: string;
    startLine: number;
    contentHash: string;
}

interface IndexerStats {
    totalNotes: number;
    totalEmbeddings: number;
    pendingEmbeddings: number;
    lastIndexedAt: number | null;
}
```

## Service Architecture

### Data Flow

```
Markdown Files (Vault)
        ↓
FileWatcherService (detects changes)
        ↓
IndexerService (parses & stores)
        ↓
NoteRepository + ChunkRepository (SQLite)
        ↓
TextSearchService (MiniSearch index)

For semantic features:
NoteRepository → EmbeddingService (Jina API) → VectorRepository
        ↓
VectorService (cosine similarity)
        ↓
SearchModal / SimilarNotesView
```

### Service Responsibilities

| Service | Responsibility |
|---------|----------------|
| `DatabaseManager` | sql.js WASM lifecycle, backup/restore, migrations |
| `IndexerService` | Full vault scan, progressive indexing, title extraction |
| `FileWatcherService` | Real-time file change detection, debounced batching |
| `TextSearchService` | MiniSearch wrapper, fuzzy search, snippet generation |
| `EmbeddingService` | Jina API calls, batch processing, retry with backoff |
| `VectorService` | Cosine similarity, semantic search, similar notes |
| `SearchWeightService` | Ranking adjustments (title, backlinks, tags) |
| `EmbeddingMaintenanceService` | Auto-regenerate embeddings on content changes |

## Plugin Settings

```typescript
interface IdeaFinderSettings {
    jinaApiKey: string;              // Jina AI API key
    keywordWeight: number;           // 0-1, default 0.3
    semanticWeight: number;          // 0-1, default 0.7
    similarityThreshold: number;     // 0-100%, default 30
    autoMaintainEmbeddings: boolean; // Auto-regenerate, default true
    folderFilter: {
        mode: "exclude" | "include";
        folders: string[];           // Relative paths
    };
    searchWeights: {
        title: number;               // 1.0-5.0, default 2.0
        backlink: number;            // 0-5.0, default 1.5
        tag: number;                 // 0-3.0, default 1.0
    };
    chunkingOptions: {
        maxHeadingLevel: number;     // 1-6, default 2
        minChunkLength: number;      // 10-500, default 50
    };
}
```

## API Integration

### Jina AI Embeddings

```typescript
// Endpoint
POST https://api.jina.ai/v1/embeddings

// Headers
Authorization: Bearer {apiKey}
Content-Type: application/json

// Request
{
    "model": "jina-embeddings-v3",
    "input": ["text1", "text2", ...]
}

// Response
{
    "data": [
        { "embedding": [0.1, 0.2, ...] },  // 1024 dimensions
        ...
    ]
}
```

**Configuration** (from `src/config/constants.ts`):
- Batch size: 10 notes/chunks per request
- Max text length: 8000 characters (truncated)
- Retry: exponential backoff (1s → 60s, max 5 retries)
- Jitter: 0-1000ms random delay between retries

## Error Handling

Structured errors in `src/errors/index.ts`:

| Error Class | Code | Retryable | Cause |
|-------------|------|-----------|-------|
| `RateLimitError` | RATE_LIMIT | Yes | HTTP 429 |
| `AuthenticationError` | AUTH_ERROR | No | HTTP 401 |
| `QuotaExceededError` | QUOTA_EXCEEDED | No | HTTP 402 |
| `ServerError` | SERVER_ERROR | Yes | HTTP 5xx |
| `NetworkError` | NETWORK_ERROR | Yes | Connection failed |
| `TimeoutError` | TIMEOUT | Yes | Request timeout |
| `ConfigurationError` | CONFIG_ERROR | No | Missing API key |
| `ConcurrencyError` | CONCURRENCY_ERROR | No | Already running |

## Code Conventions

### SQL Queries - ALWAYS Use Prepared Statements

```typescript
// CORRECT - Safe from SQL injection
const stmt = db.prepare("SELECT * FROM notes WHERE id = ?");
stmt.bind([noteId]);
while (stmt.step()) {
    const row = stmt.getAsObject();
    // ...
}
stmt.free();  // Always free statements!

// WRONG - Never use string interpolation
db.exec(`SELECT * FROM notes WHERE id = '${noteId}'`);
```

### Vector Storage

```typescript
// To BLOB (for storage)
const float32 = new Float32Array(vector);
const blob = new Uint8Array(float32.buffer, float32.byteOffset, float32.byteLength);

// From BLOB (from storage)
const uint8 = row.vector as Uint8Array;
const float32 = new Float32Array(uint8.buffer, uint8.byteOffset, uint8.byteLength / 4);
```

### Obsidian API Usage

```typescript
// Reading file content (cached, fast)
const content = await app.vault.cachedRead(file);

// Debouncing (use Obsidian's built-in)
import { debounce } from "obsidian";
const debouncedFn = debounce(fn, 300, true);

// Notices - use utilities from src/utils/notice.ts
showSuccess("Done!");     // 4000ms
showError("Failed");      // 6000ms
showWarning("Caution");   // 5000ms
showInfo("FYI");          // 3500ms
showProgress("Working..."); // 3000ms
```

### File Watching Pattern

```typescript
// Unified debounced queue (FileWatcherService pattern)
private pendingChanges = new Map<string, FileChangeEvent>();

private queueChange(event: FileChangeEvent): void {
    this.pendingChanges.set(event.path, event);
    this.processChangesDebounced();  // Debounced batch processor
}
```

## Build Configuration

Output requirements (Obsidian plugin standard):
- Single file: `main.js`
- Format: CommonJS (not ESM!)
- External: `obsidian` module (provided by host)
- Sourcemaps: inline in dev mode only

## Testing Locally

1. Clone repository
2. `npm install`
3. `npm run setup` (symlinks to vault)
4. `npm run dev` (watch mode)
5. Enable "Idea Finder" in Obsidian settings
6. Hot Reload plugin detects `.hotreload` file for auto-reload

## Common Issues

### "Database validation failed"
- Database corruption detected
- Auto-restores from `.obsidian/plugins/idea-finder/index.db.backup`
- Creates fresh database if backup fails

### "API Key not configured"
- Set Jina API key in plugin settings
- Get key from https://jina.ai/

### Race Conditions in Search
- SearchModal uses `currentQueryId` to discard stale results
- Keyword results return immediately, semantic merged async

### Embedding Stale After Edit
- `content_hash` tracks content changes
- EmbeddingMaintenanceService auto-regenerates if enabled
- Manual: Settings → Generate Embeddings

### WASM Loading Issues
- sql.js WASM loaded from CDN: `https://sql.js.org/dist/sql-wasm.wasm`
- Requires internet on first load (cached after)

## Performance Optimizations

1. **Progressive Indexing**: Priority files (recent, linked) indexed first
2. **Batch Database Ops**: IN clauses with 100 items per batch
3. **Debounced File Watching**: 300ms debounce, unified queue
4. **LRU Search Cache**: 20 entries for repeated queries
5. **Vector Buffer Views**: Float32Array without extra allocation
6. **Snippet Generation**: Single pre-compiled regex for all terms

## Commands

| Command ID | Name | Description |
|------------|------|-------------|
| `open-search` | Search notes | Open hybrid search modal |
| `rebuild-index` | Rebuild index | Re-scan entire vault |
| `open-similar-notes` | Show similar notes | Open sidebar panel |
| `generate-embeddings` | Generate embeddings | Process all notes |

## UI Components

### SearchModal (`SuggestModal`)
- Hybrid search: keyword (30%) + semantic (70%)
- Fallback: keyword-only if no embeddings
- Shows search history on empty query
- Real-time results with race condition protection

### SimilarNotesView (`ItemView`)
- Sidebar panel showing similar notes
- Updates on active file change
- Requires embeddings to be generated
- Click to open in new tab
