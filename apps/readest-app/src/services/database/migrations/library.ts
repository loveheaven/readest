import { MigrationEntry } from '../migrate';

/**
 * Library SQLite schema (Step 1 of the JSON → SQLite migration plan).
 *
 * Scope of this initial migration:
 *
 *   - `books`             — 1:1 replacement for the Book[] rows that used to
 *                            live in Books/library.json. The hot paths
 *                            (`progress update` on every 2s autosave, batch
 *                            import on the library page, OPDS subscription
 *                            refresh) hit this table with single-row UPDATEs
 *                            instead of rewriting a multi-MB JSON document.
 *                            Bench (apps/readest-app/bench/library-storage)
 *                            measured ~83× progress-update speedup and ~19×
 *                            batch-import speedup on M1 Pro.
 *
 *   - `book_progress`     — denormalised progress projection used by the
 *                            library page's progress badge / sort. It is
 *                            kept in sync via the same UPDATE that mutates
 *                            `books.progress_*` so reads can stay narrow.
 *                            (`SELECT current, total FROM book_progress
 *                             WHERE book_hash = ?`)
 *
 *   - `library_meta`      — single-row anchor for non-Book runtime state we
 *                            currently store in localStorage. Reserved for
 *                            future use (e.g. last visited group, library
 *                            sort order) — empty in this migration.
 *
 * Out of scope (future migrations, separate PRs):
 *
 *   - book_config         — Books/<hash>/config.json still lives on disk so
 *                            backups, WebDAV sync and Foliate import keep
 *                            working unchanged. The Sqlite repo still calls
 *                            into bookService for {load,save}BookConfig.
 *
 *   - book_nav            — Books/<hash>/nav.json idem. Cached nav rebuild
 *                            cost is per-open, not hot enough to migrate yet.
 *
 *   - book_notes (FTS)    — full-text search across annotations becomes
 *                            trivial once booknotes live in their own table,
 *                            but that's a meaningful schema design effort.
 *
 * Indexing rationale:
 *
 *   - `idx_books_deleted_updated` — the library page filters out soft-deleted
 *     books and sorts the visible set by updated_at. The covering ordering
 *     means the dominant `SELECT ... FROM books WHERE deleted_at IS NULL
 *     ORDER BY updated_at DESC` reads sequentially off the index.
 *
 *   - `idx_books_meta_hash`       — the dedup path in bookService.importBook
 *     needs O(1) lookup by metaHash + format to decide whether a new file
 *     is "the same book in a different binary". The current implementation
 *     does a linear scan of the in-memory Book[]; once SQLite is in front
 *     we can offload this to the index without materialising the whole table.
 *
 *   - `idx_books_synced_at`       — cloud sync (sync/* and webdav/*) currently
 *     walks the entire library to find rows changed since a cursor. The
 *     index lets the pull loop become `WHERE synced_at > ? OR updated_at > ?`.
 *
 * All columns are NOT NULL where the application invariant guarantees a
 * value (hash / format / title / author / timestamps). Optional columns
 * (`metadata_json`, `tags_json`, `progress_current`, ...) default to NULL.
 *
 * `metadata_json` and `tags_json` are deliberately kept as opaque JSON
 * BLOBs in this migration — the Book.metadata schema is large and still
 * evolving (cover image bytes, identifiers from multiple providers), and
 * surfacing it as relational columns now would force a schema migration on
 * every metadata-provider change. The library grid never needs metadata,
 * so we always SELECT-project these columns out of the hot path.
 */
export const libraryMigrations: MigrationEntry[] = [
  {
    name: '2026053001_library_init',
    sql: `
      CREATE TABLE IF NOT EXISTS books (
        hash TEXT PRIMARY KEY,
        format TEXT NOT NULL,
        title TEXT NOT NULL,
        author TEXT NOT NULL,
        source_title TEXT,
        meta_hash TEXT,
        url TEXT,
        file_path TEXT,
        cover_image_url TEXT,
        group_id TEXT,
        group_name TEXT,
        tags_json TEXT,
        progress_current INTEGER,
        progress_total INTEGER,
        reading_status TEXT,
        primary_language TEXT,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        uploaded_at INTEGER,
        downloaded_at INTEGER,
        cover_downloaded_at INTEGER,
        synced_at INTEGER,
        last_updated INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_books_deleted_updated
      ON books (deleted_at, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_books_meta_hash
      ON books (meta_hash, format)
      WHERE meta_hash IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_books_synced_at
      ON books (synced_at)
      WHERE synced_at IS NOT NULL;

      CREATE TABLE IF NOT EXISTS book_progress (
        book_hash TEXT PRIMARY KEY REFERENCES books(hash) ON DELETE CASCADE,
        current INTEGER NOT NULL,
        total INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS library_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
];
