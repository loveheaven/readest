import type { Book, BookConfig } from '@/types/book';
import type { SystemSettings } from '@/types/settings';
import type { FileSystem } from '@/types/system';
import type { BookNav } from '@/services/nav';
import { getConfigFilename } from '@/utils/book';

import * as BookSvc from '@/services/bookService';
import * as LibrarySvc from '@/services/libraryService';

import type { LibraryRepository } from './types';

/**
 * Legacy on-disk storage backend.
 *
 * Layout (unchanged from before the repository abstraction landed):
 *   Books/
 *     library.json                ← full Book[] table
 *     library.json.bak            ← atomic-write tail
 *     <hash>/
 *       <bookfile>                ← original epub/pdf/...
 *       cover.png                 ← optional
 *       config.json               ← BookConfig (progress + booknotes + viewSettings)
 *       nav.json                  ← cached BookNav (versioned, rebuilt on miss)
 *
 * This implementation is intentionally a thin wrapper around the
 * pre-existing pure functions in libraryService / bookService — no
 * behaviour change. It exists so that:
 *
 *   1. The AppService no longer reaches into LibrarySvc / BookSvc
 *      directly, which lets us swap in a SqliteLibraryRepository
 *      without touching call sites.
 *   2. Backups, WebDAV, and the import dedup path keep working
 *      against the same files — every other system in the codebase
 *      that reads/writes library.json / config.json continues to
 *      operate via the same fs abstraction, no migration required.
 */
export class JsonLibraryRepository implements LibraryRepository {
  constructor(
    private readonly fs: FileSystem,
    private readonly generateCoverImageUrl: (book: Book) => Promise<string>,
  ) {}

  loadLibraryBooks(): Promise<Book[]> {
    return LibrarySvc.loadLibraryBooks(this.fs, this.generateCoverImageUrl);
  }

  saveLibraryBooks(books: Book[]): Promise<void> {
    return LibrarySvc.saveLibraryBooks(this.fs, books);
  }

  loadBookConfig(book: Book, settings: SystemSettings): Promise<BookConfig> {
    return BookSvc.loadBookConfig(this.fs, book, settings);
  }

  saveBookConfig(book: Book, config: BookConfig, settings?: SystemSettings): Promise<void> {
    return BookSvc.saveBookConfig(this.fs, book, config, settings);
  }

  loadBookNav(book: Book): Promise<BookNav | null> {
    return BookSvc.loadBookNav(this.fs, book);
  }

  saveBookNav(book: Book, nav: BookNav): Promise<void> {
    return BookSvc.saveBookNav(this.fs, book, nav);
  }

  /**
   * No-op for the JSON backend: every saveBookConfig already writes the
   * sidecar on disk, so there's nothing for export-time consumers to
   * "materialise". Implemented to satisfy the interface contract.
   */
  async materializeBookConfigSidecar(_book: Book): Promise<void> {
    // intentionally empty
  }

  /**
   * Read the raw on-disk Books/<hash>/config.json — the canonical shape
   * for this backend. Returns null when the sidecar is missing or
   * unparseable (matches the behaviour mergeBooks already had when the
   * file was absent or corrupt; corrupt configs were just skipped).
   */
  async loadBookConfigRaw(book: Book): Promise<Partial<BookConfig> | null> {
    const path = getConfigFilename(book);
    if (!(await this.fs.exists(path, 'Books'))) return null;
    try {
      const str = (await this.fs.readFile(path, 'Books', 'text')) as string;
      return JSON.parse(str) as Partial<BookConfig>;
    } catch {
      return null;
    }
  }
}
