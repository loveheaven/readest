import type { AppService, BaseDir, FileSystem } from '@/types/system';
import type { DatabaseRow, DatabaseService } from '@/types/database';
import type { Book, BookConfig } from '@/types/book';
import type { SystemSettings } from '@/types/settings';
import type { BookNav } from '@/services/nav';

import * as LibrarySvc from '@/services/libraryService';

import { JsonLibraryRepository } from './jsonRepository';
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
 * What's migrated:
 *   - The Book[] table that used to live in Books/library.json. Single
 *     UPDATE per progress autosave instead of rewriting the whole
 *     library JSON file twice (atomic main + backup).
 *
 * What's NOT migrated (yet):
 *   - Books/<hash>/config.json — still on disk. The legacy
 *     JsonLibraryRepository handles {load,save}{BookConfig,BookNav}
 *     unchanged so backupService, WebDAVSync, the importBook dedup
 *     path and the Foliate import adapter all keep working without
 *     any changes. A follow-up PR can move config + nav once the
 *     books-table migration has soaked.
 *
 * First-launch behaviour:
 *
 *   On every loadLibraryBooks() we check whether the books table is
 *   empty AND a legacy library.json exists; if so we seed the table
 *   from it. The seed is idempotent (uses INSERT OR IGNORE on the
 *   hash PK) and only runs while the table is empty, so this stays
 *   a no-op on subsequent launches. After seeding we leave the JSON
 *   file in place — backups and WebDAV can keep reading it until a
 *   later PR teaches them to read from SQLite.
 *
 *   This means existing installs upgrade transparently: the very
 *   first launch reads from library.json, populates the table, and
 *   subsequent launches read straight from SQLite.
 */
export class SqliteLibraryRepository implements LibraryRepository {
  /** Legacy JSON backend used for everything not yet migrated. */
  private readonly jsonRepo: JsonLibraryRepository;

  /** True once we've successfully verified / seeded the table. */
  private bootstrapped = false;

  constructor(
    private readonly appService: Pick<AppService, 'openDatabase'>,
    private readonly fs: FileSystem,
    private readonly generateCoverImageUrl: (book: Book) => Promise<string>,
  ) {
    this.jsonRepo = new JsonLibraryRepository(fs, generateCoverImageUrl);
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

  // The {load,save}{BookConfig,BookNav} pair still routes through the
  // file-based backend. Migrating config.json into SQLite is a deliberate
  // follow-up PR — keeping it on disk for now means:
  //   1. backupService.exportLibrary keeps producing the existing zip
  //      layout that older app versions can still restore from.
  //   2. WebDAVSync.pushBookConfig / pullBookConfig keep round-tripping
  //      the same files the protocol already understands.
  //   3. importBook's mergeBooks dedup path keeps reading peer config.json
  //      files for booknote merging without needing a DB query.
  // None of those code paths are on the hot write path that bench flagged
  // (progress update / batch import), so deferring them costs us no perf
  // and saves significant blast radius for the first PR.

  loadBookConfig(book: Book, settings: SystemSettings): Promise<BookConfig> {
    return this.jsonRepo.loadBookConfig(book, settings);
  }

  saveBookConfig(book: Book, config: BookConfig, settings?: SystemSettings): Promise<void> {
    return this.jsonRepo.saveBookConfig(book, config, settings);
  }

  loadBookNav(book: Book): Promise<BookNav | null> {
    return this.jsonRepo.loadBookNav(book);
  }

  saveBookNav(book: Book, nav: BookNav): Promise<void> {
    return this.jsonRepo.saveBookNav(book, nav);
  }
}
