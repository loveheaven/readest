import type { Book, BookConfig } from '@/types/book';
import type { SystemSettings } from '@/types/settings';
import type { BookNav } from '@/services/nav';

/**
 * Library persistence abstraction.
 *
 * Concrete implementations:
 *   - JsonLibraryRepository: the legacy storage backend that writes
 *     `Books/library.json` (full table) and `Books/<hash>/{config,nav}.json`
 *     via the FileSystem abstraction. Preserves the on-disk layout that
 *     existing installs (and WebDAV / backup / cloud sync) rely on.
 *   - SqliteLibraryRepository (next step): persists the same data into
 *     a single `library.db` opened via AppService.openDatabase. The
 *     hot paths (progress autosave, batch import, library index load)
 *     no longer fan out to dozens of writes — they become single SQL
 *     statements or one transaction.
 *
 * The interface intentionally mirrors the AppService methods 1:1 so
 * existing call sites (`libraryStore`, `bookDataStore`, `readerStore`,
 * `ingestService`, `useOPDSSubscriptions`, `useLibrary`, `backupService`,
 * `WebDAVSync` injection point) stay unchanged. Migration / repo
 * selection happens entirely inside the AppService wiring.
 */
export interface LibraryRepository {
  /**
   * Load all Book metadata rows. Implementations must populate
   * `Book.coverImageUrl` (the JSON backend rehydrates it from disk;
   * the SQLite backend will do the same — `coverImageUrl` is NOT
   * persisted in either storage).
   */
  loadLibraryBooks(): Promise<Book[]>;

  /**
   * Replace the Book[] table. Implementations must strip the
   * volatile `coverImageUrl` field before persisting.
   *
   * NOTE: Today every caller passes the full library array; the
   * SQLite backend will diff against the existing row set to avoid
   * rewriting unchanged rows, but the signature stays identical so
   * callers do not need to change.
   */
  saveLibraryBooks(books: Book[]): Promise<void>;

  /**
   * Load a single book's reader state (progress, location, booknotes,
   * view settings, etc.). When `settings` is supplied the result is
   * deserialised against the user's globalViewSettings; callers that
   * need the raw on-disk shape (export, sync diff) pass a synthetic
   * settings bag — see existing callers.
   */
  loadBookConfig(book: Book, settings: SystemSettings): Promise<BookConfig>;

  /**
   * Persist a single book's reader state. `settings` is optional:
   * when present, the config is compressed against globalViewSettings;
   * when absent, the config is written raw (used by WebDAV pull /
   * importBook config-migration / backup restore).
   */
  saveBookConfig(book: Book, config: BookConfig, settings?: SystemSettings): Promise<void>;

  /**
   * Load the cached navigation artifact (TOC offsets / page map)
   * produced by services/nav. Returns null when missing or stale —
   * callers recompute and call saveBookNav in that case.
   */
  loadBookNav(book: Book): Promise<BookNav | null>;

  /** Persist a freshly-computed navigation artifact for a book. */
  saveBookNav(book: Book, nav: BookNav): Promise<void>;

  /**
   * Reconstruct the on-disk Books/<hash>/config.json sidecar from the
   * canonical store. The hot-path `saveBookConfig` no longer mirrors to
   * disk, so export-time consumers (backup zip writer; future Foliate
   * exporter) call this just before scanning the per-book directory
   * for files to package.
   *
   * Implementations that already write the sidecar on every save (the
   * legacy JSON repo) treat this as a no-op.
   */
  materializeBookConfigSidecar(book: Book): Promise<void>;

  /**
   * Return the canonical BookConfig in its raw on-disk shape — i.e.
   * the same dictionary the legacy sidecar would contain, with
   * booknotes inlined and viewSettings unstripped — without applying
   * globalViewSettings. Used by import-time dedup paths (mergeBooks)
   * that need to read peer books' progress + booknotes without caring
   * about the active reader's view preferences.
   *
   * Returns null when the book has no stored config (a book that
   * was added but never opened).
   */
  loadBookConfigRaw(book: Book): Promise<Partial<BookConfig> | null>;
}
