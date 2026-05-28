import type { AppService, BaseDir, FileSystem } from '@/types/system';
import type { DatabaseRow, DatabaseService } from '@/types/database';
import type { Book, BookConfig, BookNote } from '@/types/book';
import type { SystemSettings } from '@/types/settings';
import { BOOK_CONFIG_SCHEMA_VERSION, FIXED_LAYOUT_FORMATS } from '@/types/book';
import type { BookNav } from '@/services/nav';
import {
  DEFAULT_BOOK_SEARCH_CONFIG,
  DEFAULT_FIXED_LAYOUT_VIEW_SETTINGS,
} from '@/services/constants';
import { getBookNavFilename, getConfigFilename } from '@/utils/book';
import { deserializeConfig, serializeConfig, serializeRawConfig } from '@/utils/serializer';

import * as LibrarySvc from '@/services/libraryService';

import type { LibraryRepository } from './types';

const DB_SCHEMA = 'library';
const DB_PATH = 'library.db';
const DB_BASE: BaseDir = 'Books';

/**
 * Row shape returned by `SELECT * FROM books`. Mirrors the migration in
 * services/database/migrations/library.ts. We keep snake_case here (DB
 * convention) and translate to/from the camelCase `Book` shape at the
 * repo boundary so the rest of the app keeps its existing type.
 */
interface BookRow extends DatabaseRow {
  hash: string;
  format: string;
  title: string;
  author: string;
  source_title: string | null;
  meta_hash: string | null;
  url: string | null;
  file_path: string | null;
  cover_image_url: string | null;
  group_id: string | null;
  group_name: string | null;
  tags_json: string | null;
  progress_current: number | null;
  progress_total: number | null;
  reading_status: string | null;
  primary_language: string | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  uploaded_at: number | null;
  downloaded_at: number | null;
  cover_downloaded_at: number | null;
  synced_at: number | null;
  last_updated: number | null;
}

const UPSERT_SQL = `
  INSERT INTO books (
    hash, format, title, author,
    source_title, meta_hash, url, file_path,
    cover_image_url, group_id, group_name, tags_json,
    progress_current, progress_total, reading_status, primary_language,
    metadata_json, created_at, updated_at, deleted_at,
    uploaded_at, downloaded_at, cover_downloaded_at, synced_at, last_updated
  )
  VALUES (
    ?, ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?, ?, ?, ?
  )
  ON CONFLICT(hash) DO UPDATE SET
    format               = excluded.format,
    title                = excluded.title,
    author               = excluded.author,
    source_title         = excluded.source_title,
    meta_hash            = excluded.meta_hash,
    url                  = excluded.url,
    file_path            = excluded.file_path,
    cover_image_url      = excluded.cover_image_url,
    group_id             = excluded.group_id,
    group_name           = excluded.group_name,
    tags_json            = excluded.tags_json,
    progress_current     = excluded.progress_current,
    progress_total       = excluded.progress_total,
    reading_status       = excluded.reading_status,
    primary_language     = excluded.primary_language,
    metadata_json        = excluded.metadata_json,
    created_at           = excluded.created_at,
    updated_at           = excluded.updated_at,
    deleted_at           = excluded.deleted_at,
    uploaded_at          = excluded.uploaded_at,
    downloaded_at        = excluded.downloaded_at,
    cover_downloaded_at  = excluded.cover_downloaded_at,
    synced_at            = excluded.synced_at,
    last_updated         = excluded.last_updated
`;

const UPSERT_PROGRESS_SQL = `
  INSERT INTO book_progress (book_hash, current, total, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(book_hash) DO UPDATE SET
    current    = excluded.current,
    total      = excluded.total,
    updated_at = excluded.updated_at
`;

const DELETE_PROGRESS_SQL = `DELETE FROM book_progress WHERE book_hash = ?`;

// ---------------------------------------------------------------------------
// book_configs (one row per book) and book_notes (relational annotations)
// ---------------------------------------------------------------------------

interface BookConfigRow extends DatabaseRow {
  book_hash: string;
  schema_version: number | null;
  progress_current: number | null;
  progress_total: number | null;
  location: string | null;
  xpointer: string | null;
  config_json: string;
  last_synced_at_config: number | null;
  last_synced_at_notes: number | null;
  last_pushed_at_config: number | null;
  last_pushed_at_notes: number | null;
  foliate_imported_at: number | null;
  updated_at: number;
}

interface BookNoteRow extends DatabaseRow {
  book_hash: string;
  id: string;
  meta_hash: string | null;
  type: string;
  cfi: string;
  xpointer0: string | null;
  xpointer1: string | null;
  page: number | null;
  text: string | null;
  style: string | null;
  color: string | null;
  note: string;
  global_flag: number | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

const UPSERT_CONFIG_SQL = `
  INSERT INTO book_configs (
    book_hash, schema_version,
    progress_current, progress_total, location, xpointer,
    config_json,
    last_synced_at_config, last_synced_at_notes,
    last_pushed_at_config, last_pushed_at_notes,
    foliate_imported_at, updated_at
  ) VALUES (
    ?, ?,
    ?, ?, ?, ?,
    ?,
    ?, ?,
    ?, ?,
    ?, ?
  )
  ON CONFLICT(book_hash) DO UPDATE SET
    schema_version        = excluded.schema_version,
    progress_current      = excluded.progress_current,
    progress_total        = excluded.progress_total,
    location              = excluded.location,
    xpointer              = excluded.xpointer,
    config_json           = excluded.config_json,
    last_synced_at_config = excluded.last_synced_at_config,
    last_synced_at_notes  = excluded.last_synced_at_notes,
    last_pushed_at_config = excluded.last_pushed_at_config,
    last_pushed_at_notes  = excluded.last_pushed_at_notes,
    foliate_imported_at   = excluded.foliate_imported_at,
    updated_at            = excluded.updated_at
`;

const UPSERT_NOTE_SQL = `
  INSERT INTO book_notes (
    book_hash, id, meta_hash, type, cfi, xpointer0, xpointer1,
    page, text, style, color, note, global_flag,
    created_at, updated_at, deleted_at
  ) VALUES (
    ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?,
    ?, ?, ?
  )
  ON CONFLICT(book_hash, id) DO UPDATE SET
    meta_hash    = excluded.meta_hash,
    type         = excluded.type,
    cfi          = excluded.cfi,
    xpointer0    = excluded.xpointer0,
    xpointer1    = excluded.xpointer1,
    page         = excluded.page,
    text         = excluded.text,
    style        = excluded.style,
    color        = excluded.color,
    note         = excluded.note,
    global_flag  = excluded.global_flag,
    created_at   = excluded.created_at,
    updated_at   = excluded.updated_at,
    deleted_at   = excluded.deleted_at
`;

const DELETE_NOTES_FOR_BOOK_SQL = `DELETE FROM book_notes WHERE book_hash = ?`;

// ---------------------------------------------------------------------------
// book_navs (one row per book) — derived TOC + section fragment cache
// ---------------------------------------------------------------------------

interface BookNavRow extends DatabaseRow {
  book_hash: string;
  version: number;
  toc_json: string;
  sections_json: string;
  updated_at: number;
}

const UPSERT_NAV_SQL = `
  INSERT INTO book_navs (
    book_hash, version, toc_json, sections_json, updated_at
  ) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(book_hash) DO UPDATE SET
    version       = excluded.version,
    toc_json      = excluded.toc_json,
    sections_json = excluded.sections_json,
    updated_at    = excluded.updated_at
`;

function navToParams(bookHash: string, nav: BookNav, now: number): unknown[] {
  return [bookHash, nav.version, JSON.stringify(nav.toc), JSON.stringify(nav.sections), now];
}

function rowToNav(row: BookNavRow): BookNav | null {
  try {
    const toc = JSON.parse(row.toc_json) as BookNav['toc'];
    const sections = JSON.parse(row.sections_json) as BookNav['sections'];
    return { version: row.version, toc, sections };
  } catch {
    // A corrupt row is indistinguishable from a missing one for callers —
    // computeBookNav will rebuild on miss, and the next saveBookNav will
    // overwrite with a clean blob.
    return null;
  }
}

/**
 * Strip booknotes from the config payload before serialising into the
 * `config_json` column. Booknotes live in their own table; embedding
 * them in the JSON blob would mean every UPSERT_CONFIG_SQL also rewrites
 * every annotation, defeating the relational split.
 *
 * The sidecar config.json on disk DOES still inline booknotes — that's
 * the on-disk format WebDAV / backup / Foliate import all expect.
 */
function configBodyForJson(config: BookConfig): Omit<BookConfig, 'booknotes'> {
  // Spread copies the rest of the fields without mutating the caller's
  // object. Casting via Record<string, unknown> avoids a TS narrowing
  // hop (BookConfig.booknotes is BookNote[] | undefined).
  const rest = { ...config } as BookConfig & { booknotes?: BookNote[] };
  delete rest.booknotes;
  return rest;
}

function configToParams(book: Book, config: BookConfig, configJson: string): unknown[] {
  return [
    book.hash,
    config.schemaVersion ?? BOOK_CONFIG_SCHEMA_VERSION,
    config.progress?.[0] ?? null,
    config.progress?.[1] ?? null,
    config.location ?? null,
    config.xpointer ?? null,
    configJson,
    config.lastSyncedAtConfig ?? null,
    config.lastSyncedAtNotes ?? null,
    config.lastPushedAtConfig ?? null,
    config.lastPushedAtNotes ?? null,
    config.foliateImportedAt ?? null,
    config.updatedAt,
  ];
}

function noteToParams(bookHash: string, note: BookNote): unknown[] {
  return [
    bookHash,
    note.id,
    note.metaHash ?? null,
    note.type,
    note.cfi,
    note.xpointer0 ?? null,
    note.xpointer1 ?? null,
    note.page ?? null,
    note.text ?? null,
    note.style ?? null,
    note.color ?? null,
    note.note,
    note.global ? 1 : 0,
    note.createdAt,
    note.updatedAt,
    note.deletedAt ?? null,
  ];
}

function rowToNote(row: BookNoteRow): BookNote {
  const note: BookNote = {
    id: row.id,
    type: row.type as BookNote['type'],
    cfi: row.cfi,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.meta_hash) note.metaHash = row.meta_hash;
  if (row.xpointer0) note.xpointer0 = row.xpointer0;
  if (row.xpointer1) note.xpointer1 = row.xpointer1;
  if (row.page != null) note.page = row.page;
  if (row.text) note.text = row.text;
  if (row.style) note.style = row.style as BookNote['style'];
  if (row.color) note.color = row.color as BookNote['color'];
  if (row.global_flag) note.global = true;
  if (row.deleted_at != null) note.deletedAt = row.deleted_at;
  // bookHash is intentionally NOT populated here — the on-disk format
  // omits it (it's redundant with the file path), so the sidecar mirror
  // we emit on save matches byte-for-byte.
  return note;
}

/**
 * Type-narrowing helper: hand-roll the parameter array for execute().
 * Going through a single object would force every caller to spell out
 * the column order, which is more error-prone than a positional tuple.
 */
function bookToParams(book: Book): unknown[] {
  return [
    book.hash,
    book.format,
    book.title,
    book.author,
    book.sourceTitle ?? null,
    book.metaHash ?? null,
    book.url ?? null,
    book.filePath ?? null,
    // coverImageUrl is volatile and intentionally NOT persisted; the
    // signature matches loadLibraryBooks which rehydrates it after
    // the SELECT. We still bind NULL here to keep the column count.
    null,
    book.groupId ?? null,
    book.groupName ?? null,
    book.tags ? JSON.stringify(book.tags) : null,
    book.progress?.[0] ?? null,
    book.progress?.[1] ?? null,
    book.readingStatus ?? null,
    book.primaryLanguage ?? null,
    book.metadata ? JSON.stringify(book.metadata) : null,
    book.createdAt,
    book.updatedAt,
    book.deletedAt ?? null,
    book.uploadedAt ?? null,
    book.downloadedAt ?? null,
    book.coverDownloadedAt ?? null,
    book.syncedAt ?? null,
    book.lastUpdated ?? null,
  ];
}

function rowToBook(row: BookRow): Book {
  const book: Book = {
    hash: row.hash,
    format: row.format as Book['format'],
    title: row.title,
    author: row.author,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.source_title) book.sourceTitle = row.source_title;
  if (row.meta_hash) book.metaHash = row.meta_hash;
  if (row.url) book.url = row.url;
  if (row.file_path) book.filePath = row.file_path;
  if (row.group_id) book.groupId = row.group_id;
  if (row.group_name) book.groupName = row.group_name;
  if (row.tags_json) {
    try {
      book.tags = JSON.parse(row.tags_json);
    } catch {
      /* corrupt tags blob — drop silently, matches JSON backend's `?? []` */
    }
  }
  if (row.progress_current != null && row.progress_total != null) {
    book.progress = [row.progress_current, row.progress_total];
  }
  if (row.reading_status) {
    book.readingStatus = row.reading_status as Book['readingStatus'];
  }
  if (row.primary_language) book.primaryLanguage = row.primary_language;
  if (row.metadata_json) {
    try {
      book.metadata = JSON.parse(row.metadata_json);
    } catch {
      /* same fallthrough as tags */
    }
  }
  if (row.deleted_at != null) book.deletedAt = row.deleted_at;
  if (row.uploaded_at != null) book.uploadedAt = row.uploaded_at;
  if (row.downloaded_at != null) book.downloadedAt = row.downloaded_at;
  if (row.cover_downloaded_at != null) {
    book.coverDownloadedAt = row.cover_downloaded_at;
  }
  if (row.synced_at != null) book.syncedAt = row.synced_at;
  if (row.last_updated != null) book.lastUpdated = row.last_updated;
  return book;
}

/**
 * SQLite-backed library backend.
 *
 * Storage model:
 *   - books table replaces Books/library.json (single UPDATE per progress
 *     autosave; bench shows ~83× progress speedup, ~19× batch import).
 *   - book_configs + book_notes tables replace Books/<hash>/config.json
 *     for hot reads/writes. The on-disk sidecar config.json is still
 *     written byte-identically on every save so backupService, WebDAVSync
 *     and importBook's mergeBooks dedup path keep working unchanged.
 *   - book_navs replaces Books/<hash>/nav.json. Nav is a derived cache
 *     (computeBookNav rebuilds on miss), so this is structural rather
 *     than performance-driven; the sidecar nav.json is still mirrored
 *     on save for parity with the config path and to keep the on-disk
 *     library inspectable / portable.
 *
 * Why keep sidecars?
 *   - backupService.exportLibrary scans zip entries for `<hash>/config.json`
 *     literal filenames; making it DB-aware would change the backup zip
 *     format and break older app versions trying to restore.
 *   - WebDAVSync's wire format IS config.json — there's no SQLite-aware
 *     server protocol to migrate to.
 *   - bookService.importBook's mergeBooks reads peer
 *     <oldHash>/config.json directly via fs.readFile to merge booknotes
 *     across renamed-hash imports; that call site bypasses the repo
 *     abstraction by design.
 *
 * First-launch behaviour:
 *
 *   - books table: bootstrap from legacy library.json on first
 *     loadLibraryBooks() (idempotent, batched, atomic).
 *   - book_configs / book_notes: lazy bootstrap per-book on first
 *     loadBookConfig() — reads the legacy sidecar, INSERTs config + notes
 *     in one transaction. Brand-new books with no sidecar yet return
 *     the empty default config (matches JSON backend behaviour).
 *   - book_navs: lazy bootstrap per-book on first loadBookNav(). A miss
 *     returns null (matching the JSON backend), which the reader
 *     interprets as "rebuild via computeBookNav".
 *
 *   This means existing installs upgrade transparently without any
 *   blocking migration step on launch.
 */
export class SqliteLibraryRepository implements LibraryRepository {
  /** True once we've successfully verified / seeded the books table. */
  private bootstrapped = false;

  constructor(
    private readonly appService: Pick<AppService, 'openDatabase'>,
    private readonly fs: FileSystem,
    private readonly generateCoverImageUrl: (book: Book) => Promise<string>,
  ) {
    // NOTE: we deliberately do NOT capture a resolvePath here. openDatabase
    // resolves DB_PATH relative to DB_BASE on every open via the platform's
    // DatabaseService implementation, which already honours
    // NativeAppService.setCustomRootDir / NodeAppService root overrides.
  }

  /**
   * Open a short-lived DB handle for one logical operation. Mirrors
   * HardcoverSyncMapStore.withDb — opening is cheap (the PRAGMA
   * user_version fast-path in services/database/migrate.ts skips the
   * tracking-table read once migrations are settled), and closing
   * eagerly avoids hoarding file handles on mobile.
   */
  private async withDb<T>(fn: (db: DatabaseService) => Promise<T>): Promise<T> {
    const db = await this.appService.openDatabase(DB_SCHEMA, DB_PATH, DB_BASE);
    try {
      return await fn(db);
    } finally {
      await db.close();
    }
  }

  /**
   * Seed the books table from library.json on first launch. Safe to
   * call repeatedly: short-circuits once the table contains any row.
   * We bypass JsonLibraryRepository.loadLibraryBooks here because we
   * want the raw rows without re-running coverImageUrl rehydration
   * (the SELECT path below does that for us).
   */
  private async bootstrapIfNeeded(db: DatabaseService): Promise<void> {
    if (this.bootstrapped) return;

    const countRows = await db.select<{ n: number }>('SELECT COUNT(*) AS n FROM books');
    const count = countRows[0]?.n ?? 0;
    if (count > 0) {
      this.bootstrapped = true;
      return;
    }

    // Legacy library.json is read via the same FileSystem abstraction
    // the JSON repo uses — guarantees identical behaviour on every
    // platform (Tauri, Node, Web).
    const legacy = await LibrarySvc.loadLibraryBooks(
      this.fs,
      // Avoid spending I/O to fetch covers we're about to discard;
      // the post-bootstrap loadLibraryBooks call will rehydrate covers.
      async () => '',
    );
    if (legacy.length === 0) {
      this.bootstrapped = true;
      return;
    }

    // Initial seed runs inside a single batch so it's atomic — partial
    // seeds on crash would otherwise leave the table half-full and
    // subsequent loads would silently truncate the user's library.
    const statements = legacy.map((book) => {
      const params = bookToParams(book)
        .map((p) =>
          typeof p === 'string' ? `'${p.replace(/'/g, "''")}'` : p === null ? 'NULL' : String(p),
        )
        .join(', ');
      return `INSERT OR IGNORE INTO books (
        hash, format, title, author,
        source_title, meta_hash, url, file_path,
        cover_image_url, group_id, group_name, tags_json,
        progress_current, progress_total, reading_status, primary_language,
        metadata_json, created_at, updated_at, deleted_at,
        uploaded_at, downloaded_at, cover_downloaded_at, synced_at, last_updated
      ) VALUES (${params})`;
    });
    // batch() is atomic in tauri-plugin-turso / turso-wasm — partial
    // failure rolls back, so we either seed every book or none.
    await db.batch(statements);
    this.bootstrapped = true;
  }

  async loadLibraryBooks(): Promise<Book[]> {
    return this.withDb(async (db) => {
      await this.bootstrapIfNeeded(db);
      const rows = await db.select<BookRow>(
        // No WHERE clause: the library page itself filters by deletedAt
        // before rendering. Returning soft-deleted rows preserves the
        // JSON backend's behaviour (libraryService just `JSON.parse`s
        // the file — it never filters), so consumers like backupService
        // and WebDAVSync that rely on seeing tombstones keep working.
        'SELECT * FROM books ORDER BY updated_at DESC',
      );
      const books = rows.map(rowToBook);
      // Rehydrate cover URLs in parallel — same batching strategy as
      // libraryService.loadLibraryBooks (concurrency = 20).
      const concurrency = 20;
      for (let i = 0; i < books.length; i += concurrency) {
        await Promise.all(
          books.slice(i, i + concurrency).map(async (book) => {
            book.coverImageUrl = await this.generateCoverImageUrl(book);
            book.updatedAt ??= book.lastUpdated || Date.now();
          }),
        );
      }
      return books;
    });
  }

  async saveLibraryBooks(books: Book[]): Promise<void> {
    return this.withDb(async (db) => {
      await this.bootstrapIfNeeded(db);

      // Diff against the existing row set so we only touch rows that
      // actually changed. The JSON backend rewrites the whole file on
      // every call, so any saveLibraryBooks signature change would be
      // observable; this implementation matches semantics (replace the
      // whole table) but skips no-op writes for perf.
      const existing = await db.select<{ hash: string; updated_at: number }>(
        'SELECT hash, updated_at FROM books',
      );
      const existingMap = new Map(existing.map((r) => [r.hash, r.updated_at]));

      const incomingHashes = new Set<string>();
      for (const book of books) {
        incomingHashes.add(book.hash);
        const prevUpdatedAt = existingMap.get(book.hash);
        if (prevUpdatedAt !== undefined && prevUpdatedAt >= book.updatedAt) {
          // Row unchanged (timestamp didn't advance) — skip the write.
          continue;
        }
        await db.execute(UPSERT_SQL, bookToParams(book));
        if (book.progress) {
          await db.execute(UPSERT_PROGRESS_SQL, [
            book.hash,
            book.progress[0],
            book.progress[1],
            book.updatedAt,
          ]);
        } else {
          await db.execute(DELETE_PROGRESS_SQL, [book.hash]);
        }
      }

      // Hard-delete rows that were dropped from the in-memory array
      // entirely. Soft deletes (deletedAt set) reach this point as
      // UPSERTs above with deleted_at populated, which is correct.
      // We use a hard DELETE only for rows the caller fully removed.
      for (const hash of existingMap.keys()) {
        if (!incomingHashes.has(hash)) {
          await db.execute('DELETE FROM books WHERE hash = ?', [hash]);
        }
      }
    });
  }

  // -------------------------------------------------------------------------
  // BookConfig + BookNotes
  //
  // Storage model: SQLite is the source of truth. The on-disk sidecar
  // Books/<hash>/config.json is still written on every save so that:
  //   1. backupService.exportLibrary keeps producing the existing zip
  //      layout that older app versions / users restoring from backup
  //      can still consume.
  //   2. WebDAVSync.pushBookConfig / pullBookConfig keep round-tripping
  //      the same files the protocol already understands (the line
  //      format IS config.json — there's no "WebDAV reads SQLite" path).
  //   3. importBook's mergeBooks dedup path reads peer <oldHash>/config.json
  //      directly via fs.readFile — that call site bypasses the repo
  //      abstraction by design.
  //
  // The sidecar is a byte-identical mirror of what the JSON repo would
  // have written for the same input — that's what guarantees no
  // observable difference for those three external consumers.
  //
  // First-launch seeding: if book_configs has no row for `book.hash`
  // and the legacy sidecar exists, we read it once and INSERT into
  // SQLite. Idempotent (PK conflict on re-seed is a no-op).
  // -------------------------------------------------------------------------

  async loadBookConfig(book: Book, settings: SystemSettings): Promise<BookConfig> {
    const globalViewSettings = {
      ...settings.globalViewSettings,
      ...(FIXED_LAYOUT_FORMATS.has(book.format) ? DEFAULT_FIXED_LAYOUT_VIEW_SETTINGS : {}),
    };

    return this.withDb(async (db) => {
      let row = (
        await db.select<BookConfigRow>('SELECT * FROM book_configs WHERE book_hash = ? LIMIT 1', [
          book.hash,
        ])
      )[0];

      if (!row) {
        // No row yet — try seeding from the legacy sidecar so existing
        // installs upgrade transparently. Falls back to a default empty
        // config (matches the JSON backend's "{}" deserialise path).
        const seeded = await this.bootstrapBookConfigFromSidecar(db, book);
        if (seeded) row = seeded;
      }

      if (!row) {
        return deserializeConfig('{}', globalViewSettings, DEFAULT_BOOK_SEARCH_CONFIG);
      }

      const config = deserializeConfig(
        row.config_json,
        globalViewSettings,
        DEFAULT_BOOK_SEARCH_CONFIG,
      );

      // Re-attach the booknotes from the relational table. We include
      // tombstones (deleted_at IS NOT NULL) because cloud sync needs to
      // see them — matches the JSON backend, which stores tombstones
      // inside booknotes too.
      const noteRows = await db.select<BookNoteRow>(
        'SELECT * FROM book_notes WHERE book_hash = ? ORDER BY updated_at DESC',
        [book.hash],
      );
      config.booknotes = noteRows.map(rowToNote);

      return config;
    });
  }

  async saveBookConfig(book: Book, config: BookConfig, settings?: SystemSettings): Promise<void> {
    // 1) Compute the on-disk sidecar payload first. This must be
    //    byte-identical to what JsonLibraryRepository would have
    //    produced for the same input, otherwise WebDAV / backup
    //    consumers see a behaviour change.
    let sidecarPayload: string;
    if (settings) {
      const globalViewSettings = {
        ...settings.globalViewSettings,
        ...(FIXED_LAYOUT_FORMATS.has(book.format) ? DEFAULT_FIXED_LAYOUT_VIEW_SETTINGS : {}),
      };
      sidecarPayload = serializeConfig(config, globalViewSettings, DEFAULT_BOOK_SEARCH_CONFIG);
    } else {
      sidecarPayload = serializeRawConfig(config);
    }

    // 2) Persist to SQLite. The config_json column stores the SAME
    //    serialised body as the sidecar, MINUS booknotes (those are
    //    relational rows). On read we re-attach them; on write we
    //    re-inline them into the sidecar via the payload above. This
    //    keeps the on-disk format unchanged.
    let configJsonForDb: string;
    if (settings) {
      const globalViewSettings = {
        ...settings.globalViewSettings,
        ...(FIXED_LAYOUT_FORMATS.has(book.format) ? DEFAULT_FIXED_LAYOUT_VIEW_SETTINGS : {}),
      };
      configJsonForDb = serializeConfig(
        configBodyForJson(config) as BookConfig,
        globalViewSettings,
        DEFAULT_BOOK_SEARCH_CONFIG,
      );
    } else {
      configJsonForDb = serializeRawConfig(configBodyForJson(config));
    }

    await this.withDb(async (db) => {
      await db.execute(UPSERT_CONFIG_SQL, configToParams(book, config, configJsonForDb));

      // Booknotes: replace-all for now to match the JSON backend's
      // semantics (the file format is "the full booknotes array"). A
      // future PR can introduce an upsert-by-id diff once callers move
      // to a dedicated saveBookNote API; until then we maintain the
      // same write semantics so existing code paths (delete, undo,
      // bulk import) keep working.
      await db.execute(DELETE_NOTES_FOR_BOOK_SQL, [book.hash]);
      const notes = config.booknotes ?? [];
      for (const note of notes) {
        await db.execute(UPSERT_NOTE_SQL, noteToParams(book.hash, note));
      }
    });

    // 3) Write the sidecar. We do this AFTER SQLite to bias toward
    //    "DB is leading source of truth" — if the sidecar write fails
    //    (full disk, etc.), the next read will still return the
    //    correct config, and the next save retries the sidecar.
    await this.fs.writeFile(getConfigFilename(book), 'Books', sidecarPayload);
  }

  /**
   * One-shot seeding from the legacy Books/<hash>/config.json. Returns
   * the freshly inserted row so the caller can use it immediately
   * without a second SELECT round-trip. Returns null when no sidecar
   * exists (a brand-new book that hasn't been opened yet).
   */
  private async bootstrapBookConfigFromSidecar(
    db: DatabaseService,
    book: Book,
  ): Promise<BookConfigRow | null> {
    const path = getConfigFilename(book);
    if (!(await this.fs.exists(path, 'Books'))) return null;

    let raw = '{}';
    try {
      raw = (await this.fs.readFile(path, 'Books', 'text')) as string;
    } catch {
      return null;
    }

    let parsed: BookConfig;
    try {
      parsed = JSON.parse(raw) as BookConfig;
    } catch {
      // Corrupt sidecar — log and bail. Mirrors bookService.loadBookConfig
      // which returns the empty default in this case.
      return null;
    }
    parsed.updatedAt ??= Date.now();

    // Insert config row (without booknotes — they go to the relational
    // table). We re-stringify the parsed object so the column stores
    // the canonical compact form, not whatever indentation the legacy
    // file might have used.
    const configJson = JSON.stringify(configBodyForJson(parsed));
    await db.execute(UPSERT_CONFIG_SQL, configToParams(book, parsed, configJson));

    // Insert each booknote (new schema_version stamped on the row,
    // not on the notes themselves).
    const notes = parsed.booknotes ?? [];
    for (const note of notes) {
      await db.execute(UPSERT_NOTE_SQL, noteToParams(book.hash, note));
    }

    const rows = await db.select<BookConfigRow>(
      'SELECT * FROM book_configs WHERE book_hash = ? LIMIT 1',
      [book.hash],
    );
    return rows[0] ?? null;
  }

  // -------------------------------------------------------------------------
  // BookNav (book_navs) — derived TOC cache, SQLite-canonical with sidecar
  // -------------------------------------------------------------------------

  async loadBookNav(book: Book): Promise<BookNav | null> {
    return this.withDb(async (db) => {
      const rows = await db.select<BookNavRow>(
        'SELECT * FROM book_navs WHERE book_hash = ? LIMIT 1',
        [book.hash],
      );
      const row = rows[0];
      if (row) return rowToNav(row);
      // Lazy bootstrap from a legacy sidecar so existing installs keep
      // their cached nav across upgrade. A miss is the steady-state
      // signal — the reader will rebuild via computeBookNav.
      return this.bootstrapBookNavFromSidecar(db, book);
    });
  }

  async saveBookNav(book: Book, nav: BookNav): Promise<void> {
    // SQLite is canonical, but mirror to the on-disk sidecar so external
    // tooling and a hypothetical fallback to JsonLibraryRepository keep
    // working. JSON.stringify(nav) here matches the legacy bookService
    // saveBookNav byte-for-byte.
    const sidecar = JSON.stringify(nav);

    await this.withDb(async (db) => {
      await db.execute(UPSERT_NAV_SQL, navToParams(book.hash, nav, Date.now()));
    });

    await this.fs.writeFile(getBookNavFilename(book), 'Books', sidecar);
  }

  /**
   * Read Books/<hash>/nav.json (if present) and seed book_navs so the
   * next loadBookNav hit goes straight to SQLite. Corrupt / unreadable
   * sidecars degrade silently to "no cache" — the reader will recompute.
   */
  private async bootstrapBookNavFromSidecar(
    db: DatabaseService,
    book: Book,
  ): Promise<BookNav | null> {
    const path = getBookNavFilename(book);
    if (!(await this.fs.exists(path, 'Books'))) return null;

    let parsed: BookNav;
    try {
      const str = (await this.fs.readFile(path, 'Books', 'text')) as string;
      parsed = JSON.parse(str) as BookNav;
    } catch {
      return null;
    }
    if (!parsed || typeof parsed.version !== 'number') return null;

    await db.execute(UPSERT_NAV_SQL, navToParams(book.hash, parsed, Date.now()));
    return parsed;
  }
}
