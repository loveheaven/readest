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
 * Follow-up migrations (added in later versions of this same array):
 *
 *   - v2 (2026053002_book_configs_and_notes) — book_configs + book_notes.
 *     The on-disk Books/<hash>/config.json stays as a sidecar (backup,
 *     WebDAV sync line format, Foliate import path and importBook's
 *     mergeBooks dedup all read it directly), but SQLite becomes the
 *     source of truth. See that migration's preamble for design notes.
 *
 *   - v3 (2026053003_book_navs) — book_navs. Books/<hash>/nav.json moves
 *     to a SQLite row keyed by hash, with toc / sections kept as JSON
 *     blobs. The on-disk nav.json sidecar is still written byte-identically
 *     so external tooling and the legacy fallback continue to operate.
 *     Nav is a derived cache (computeBookNav rebuilds it on miss), so the
 *     migration value is structural consistency with config storage rather
 *     than I/O speed.
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

  /**
   * v2 — book_configs + book_notes.
   *
   * Why a JSON blob for the config body and a relational table for notes?
   *
   *   The BookConfig payload (location, viewSettings overrides,
   *   searchConfig overrides, rsvpPosition, schemaVersion) goes through
   *   `serializeConfig` (utils/serializer.ts) which diff-compresses
   *   viewSettings / searchConfig against globalViewSettings before write
   *   and re-hydrates them on read. Splitting that into relational
   *   columns would force every viewSettings field addition to ship a
   *   schema migration, and the diff round-trip is what the WebDAV sync
   *   protocol's `compressConfig` payload depends on. Storing the
   *   already-compressed JSON in a single column keeps the existing
   *   serialiser semantics intact and means the on-disk sidecar is a
   *   byte-identical mirror of `config_json` — backups, WebDAV pulls
   *   and Foliate imports keep round-tripping the exact same payload.
   *
   *   Booknotes are different: cross-device sync, library-wide
   *   annotation search and the "delete tombstone" path all want
   *   indexed access by hash + updated_at + deleted_at. They live in
   *   their own table with a composite PK (book_hash, id) and proper
   *   indices. The sidecar config.json still inlines `booknotes` on
   *   write (and is the source-of-truth for first-launch seeding) so
   *   no external consumer breaks.
   *
   *   Hot-path columns (`progress_current/total`, `location`,
   *   `last_synced_at_*`, `last_pushed_at_*`, `updated_at`) are
   *   denormalised onto book_configs as proper columns: cloud-sync
   *   pull cursors and the library list's progress badge query never
   *   need to parse the JSON blob.
   *
   * Sidecar policy:
   *
   *   - config.json on disk = `JSON.stringify({...sqlBlob, booknotes:
   *     [...active+deleted notes from book_notes]})`. WebDAV / backup /
   *     Foliate import read it unchanged.
   *   - On first read after upgrade, if the row is missing AND the
   *     sidecar exists, the repo seeds book_configs + book_notes from
   *     the sidecar. Idempotent (PK conflict on re-seed is a no-op).
   *
   * Indexing rationale:
   *
   *   - `idx_book_notes_book_hash_updated` lets the per-book annotation
   *     panel and the WebDAV note-pull cursor scan one book's notes in
   *     order without a full scan.
   *
   *   - `idx_book_notes_updated_at` (across books, partial on
   *     deleted_at IS NULL) is what library-wide note search and the
   *     cloud-sync "give me everything since cursor T" query use. The
   *     partial predicate keeps the index narrow for the common case
   *     and lets tombstone-aware queries fall back to the wider scan.
   *
   *   - `idx_book_configs_synced_notes` mirrors books.idx_books_synced_at
   *     for the notes-side cursor (last_synced_at_notes), the column
   *     the WebDAV/cloud sync poller actually compares against.
   */
  {
    name: '2026053002_book_configs_and_notes',
    sql: `
      CREATE TABLE IF NOT EXISTS book_configs (
        book_hash TEXT PRIMARY KEY,
        schema_version INTEGER,
        progress_current INTEGER,
        progress_total INTEGER,
        location TEXT,
        xpointer TEXT,
        config_json TEXT NOT NULL,
        last_synced_at_config INTEGER,
        last_synced_at_notes INTEGER,
        last_pushed_at_config INTEGER,
        last_pushed_at_notes INTEGER,
        foliate_imported_at INTEGER,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_book_configs_synced_notes
      ON book_configs (last_synced_at_notes)
      WHERE last_synced_at_notes IS NOT NULL;

      CREATE TABLE IF NOT EXISTS book_notes (
        book_hash TEXT NOT NULL,
        id TEXT NOT NULL,
        meta_hash TEXT,
        type TEXT NOT NULL,
        cfi TEXT NOT NULL,
        xpointer0 TEXT,
        xpointer1 TEXT,
        page INTEGER,
        text TEXT,
        style TEXT,
        color TEXT,
        note TEXT NOT NULL,
        global_flag INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        PRIMARY KEY (book_hash, id)
      );

      CREATE INDEX IF NOT EXISTS idx_book_notes_book_hash_updated
      ON book_notes (book_hash, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_book_notes_updated_at
      ON book_notes (updated_at DESC)
      WHERE deleted_at IS NULL;
    `,
  },

  /**
   * v3 — book_navs.
   *
   * BookNav is a derived cache (TOC + per-section fragment offsets) that
   * the reader rebuilds on miss via computeBookNav, so this migration is
   * not about I/O speedup — it is about ending the per-book sidecar
   * sprawl and giving sync / housekeeping queries a single table to
   * reason about. `version` lives as its own column so the existing
   * "stale cache" check (`cachedNav.version === BOOK_NAV_VERSION`) does
   * not have to parse the JSON body on every open. `toc_json` and
   * `sections_json` stay opaque because their shape evolves with the
   * nav algorithm (BOOK_NAV_VERSION bumps) and a relational layout
   * would force a schema migration on every algorithm change.
   *
   * Sidecar policy mirrors v2: SQLite is canonical, but every save
   * also writes a byte-identical Books/<hash>/nav.json so external
   * tooling and the JsonLibraryRepository fallback keep working. On
   * first read after upgrade, missing rows are seeded from the sidecar.
   */
  {
    name: '2026053003_book_navs',
    sql: `
      CREATE TABLE IF NOT EXISTS book_navs (
        book_hash TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        toc_json TEXT NOT NULL,
        sections_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
];
