import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import type { App } from "obsidian";
import type { Logger } from "../utils/Logger";

const DB_FILENAME = "index.db";
const DB_BACKUP_FILENAME = "index.db.backup";
const PLUGIN_DIR_NAME = "idea-finder";
const OLD_PLUGIN_DIR_NAME = "vibe-writing"; // For migration

export class DatabaseManager {
  private db: Database | null = null;
  private app: App;
  private initialized = false;
  private SQL: SqlJsStatic | null = null;
  private logger: Logger | null;

  constructor(app: App, logger: Logger | null = null) {
    this.app = app;
    this.logger = logger;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.logger?.info("Database: Initializing...");

    // Initialize sql.js with WASM
    this.SQL = await initSqlJs({
      // Load WASM from CDN
      locateFile: (file) => `https://sql.js.org/dist/${file}`,
    });

    // Check if migration from old plugin name is needed
    await this.migrateFromOldPluginName();

    // Try to load existing database
    const dbPath = this.getDbPath();
    const backupPath = this.getBackupPath();

    try {
      if (await this.app.vault.adapter.exists(dbPath)) {
        this.logger?.info("Database: Loading existing database...");
        const data = await this.app.vault.adapter.readBinary(dbPath);
        this.db = new this.SQL.Database(new Uint8Array(data));

        // Validate database integrity
        if (!this.validateDatabase()) {
          throw new Error("Database validation failed");
        }
      } else {
        this.logger?.info("Database: Creating new database...");
        this.db = new this.SQL.Database();
      }
    } catch (error) {
      this.logger?.error("Database: Error loading database:", error);

      // Try to restore from backup
      if (await this.tryRestoreFromBackup(backupPath)) {
        this.logger?.info("Database: Restored from backup");
      } else {
        this.logger?.info("Database: Creating fresh database...");
        this.db = new this.SQL.Database();
      }
    }

    // Create tables if they don't exist
    this.createTables();

    this.initialized = true;
    this.logger?.info("Database: Initialized successfully");
  }

  /**
   * Migrate database from old plugin name (vibe-writing) to new name (idea-finder).
   */
  private async migrateFromOldPluginName(): Promise<void> {
    const newDbPath = this.getDbPath();
    const oldPluginDir = this.app.vault.configDir + "/plugins/" + OLD_PLUGIN_DIR_NAME;
    const oldDbPath = oldPluginDir + "/" + DB_FILENAME;
    const oldBackupPath = oldPluginDir + "/" + DB_BACKUP_FILENAME;

    // If new database already exists, no migration needed
    if (await this.app.vault.adapter.exists(newDbPath)) {
      return;
    }

    // Check if old database exists
    if (await this.app.vault.adapter.exists(oldDbPath)) {
      this.logger?.info("Database: Migrating from old plugin name...");

      try {
        // Ensure new plugin directory exists
        const newPluginDir = this.app.vault.configDir + "/plugins/" + PLUGIN_DIR_NAME;
        if (!(await this.app.vault.adapter.exists(newPluginDir))) {
          await this.app.vault.adapter.mkdir(newPluginDir);
        }

        // Copy database file
        const data = await this.app.vault.adapter.readBinary(oldDbPath);
        await this.app.vault.adapter.writeBinary(newDbPath, data);
        this.logger?.info("Database: Database migrated successfully");

        // Copy backup if exists
        if (await this.app.vault.adapter.exists(oldBackupPath)) {
          const backupData = await this.app.vault.adapter.readBinary(oldBackupPath);
          await this.app.vault.adapter.writeBinary(this.getBackupPath(), backupData);
          this.logger?.info("Database: Backup migrated successfully");
        }
      } catch (error) {
        this.logger?.error("Database: Migration failed:", error);
        // Continue with fresh database if migration fails
      }
    }
  }

  /**
   * Validate database integrity by checking if tables exist and are accessible.
   */
  private validateDatabase(): boolean {
    if (!this.db) return false;

    try {
      // Check if tables exist and are queryable
      this.db.exec("SELECT COUNT(*) FROM notes");
      this.db.exec("SELECT COUNT(*) FROM embeddings");
      return true;
    } catch (error) {
      this.logger?.error("Database: Validation failed:", error);
      return false;
    }
  }

  /**
   * Try to restore database from backup file.
   */
  private async tryRestoreFromBackup(backupPath: string): Promise<boolean> {
    if (!this.SQL) return false;

    try {
      if (await this.app.vault.adapter.exists(backupPath)) {
        this.logger?.info("Database: Attempting to restore from backup...");
        const data = await this.app.vault.adapter.readBinary(backupPath);
        this.db = new this.SQL.Database(new Uint8Array(data));

        if (this.validateDatabase()) {
          return true;
        }
      }
    } catch (error) {
      this.logger?.error("Database: Backup restore failed:", error);
    }

    return false;
  }

  private getDbPath(): string {
    // Store in plugin's data folder
    const pluginDir = this.app.vault.configDir + "/plugins/" + PLUGIN_DIR_NAME;
    return pluginDir + "/" + DB_FILENAME;
  }

  private getBackupPath(): string {
    const pluginDir = this.app.vault.configDir + "/plugins/" + PLUGIN_DIR_NAME;
    return pluginDir + "/" + DB_BACKUP_FILENAME;
  }

  private createTables(): void {
    if (!this.db) throw new Error("Database not initialized");

    this.db.run(`
			CREATE TABLE IF NOT EXISTS notes (
				id TEXT PRIMARY KEY,
				file_path TEXT UNIQUE NOT NULL,
				title TEXT NOT NULL,
				content_hash TEXT NOT NULL,
				indexed_at INTEGER DEFAULT (strftime('%s', 'now'))
			)
		`);

    this.db.run(`
			CREATE TABLE IF NOT EXISTS embeddings (
				note_id TEXT PRIMARY KEY,
				vector BLOB NOT NULL,
				content_hash TEXT NOT NULL,
				FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
			)
		`);

    // Tags table for storing note tags from frontmatter
    this.db.run(`
			CREATE TABLE IF NOT EXISTS note_tags (
				note_id TEXT NOT NULL,
				tag TEXT NOT NULL,
				PRIMARY KEY (note_id, tag),
				FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
			)
		`);

    // Links table for storing [[wikilinks]] between notes
    this.db.run(`
			CREATE TABLE IF NOT EXISTS links (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				from_note_id TEXT NOT NULL,
				to_note_id TEXT,
				to_text TEXT NOT NULL,
				FOREIGN KEY (from_note_id) REFERENCES notes(id) ON DELETE CASCADE,
				FOREIGN KEY (to_note_id) REFERENCES notes(id) ON DELETE SET NULL
			)
		`);

    // Chunks table for storing note sections split by headings
    this.db.run(`
			CREATE TABLE IF NOT EXISTS note_chunks (
				id TEXT PRIMARY KEY,
				note_id TEXT NOT NULL,
				heading TEXT,
				heading_level INTEGER,
				content TEXT NOT NULL,
				start_line INTEGER NOT NULL,
				content_hash TEXT NOT NULL,
				FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
			)
		`);

    // Chunk embeddings table for semantic search on chunks
    this.db.run(`
			CREATE TABLE IF NOT EXISTS chunk_embeddings (
				chunk_id TEXT PRIMARY KEY,
				vector BLOB NOT NULL,
				content_hash TEXT NOT NULL,
				FOREIGN KEY (chunk_id) REFERENCES note_chunks(id) ON DELETE CASCADE
			)
		`);

    // Create indexes for faster lookups
    this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_notes_file_path ON notes(file_path)`
    );
    this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_notes_content_hash ON notes(content_hash)`
    );
    this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag)`
    );
    this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_note_id)`
    );
    this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_note_id)`
    );
    this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_chunks_note_id ON note_chunks(note_id)`
    );
    this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_chunks_content_hash ON note_chunks(content_hash)`
    );

    // Composite indexes for optimized JOIN queries
    this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_chunk_embed_composite ON chunk_embeddings(chunk_id, content_hash)`
    );
    this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_note_chunks_composite ON note_chunks(note_id, content_hash)`
    );
    this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_embeddings_composite ON embeddings(note_id, content_hash)`
    );
  }

  getDb(): Database {
    if (!this.db) {
      throw new Error("Database not initialized. Call initialize() first.");
    }
    return this.db;
  }

  async save(): Promise<void> {
    if (!this.db) return;

    const data = this.db.export();
    const dbPath = this.getDbPath();
    const backupPath = this.getBackupPath();

    // Ensure directory exists
    const pluginDir = this.app.vault.configDir + "/plugins/" + PLUGIN_DIR_NAME;
    if (!(await this.app.vault.adapter.exists(pluginDir))) {
      await this.app.vault.adapter.mkdir(pluginDir);
    }

    // Create backup of existing database before overwriting
    try {
      if (await this.app.vault.adapter.exists(dbPath)) {
        const existingData = await this.app.vault.adapter.readBinary(dbPath);
        await this.app.vault.adapter.writeBinary(backupPath, existingData);
      }
    } catch (error) {
      this.logger?.warn("Database: Failed to create backup:", error);
    }

    // Convert Uint8Array to ArrayBuffer for writeBinary
    await this.app.vault.adapter.writeBinary(dbPath, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    this.logger?.info("Database: Database saved");
  }

  /**
   * Reset database (delete all data and reinitialize).
   */
  async reset(): Promise<void> {
    if (!this.SQL) {
      throw new Error("SQL.js not initialized");
    }

    this.logger?.info("Database: Resetting database...");

    // Close existing database
    if (this.db) {
      this.db.close();
    }

    // Create fresh database
    this.db = new this.SQL.Database();
    this.createTables();

    // Save immediately
    await this.save();

    this.logger?.info("Database: Database reset complete");
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.initialized = false;
      this.logger?.info("Database: Database closed");
    }
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}
