/**
 * Unit tests for SqliteLibraryRepository.
 *
 * The DatabaseService is a thin in-memory mock (Map<sql, behaviour>) that
 * matches the subset of API the repo actually uses: select/execute/batch/close.
 * That's enough to verify bootstrap, diff-based saves, hard deletes and the
 * cover-rehydration path without spinning up a real Turso engine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Book, BookConfig, BookNote } from '@/types/book';
import type { SystemSettings } from '@/types/settings';
import type { AppService, BaseDir, FileSystem, FileItem, FileInfo } from '@/types/system';
import { SqliteLibraryRepository } from '@/services/library';

interface BooksRow {
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

interface ProgressRow {
  book_hash: string;
  current: number;
  total: number;
  updated_at: number;
}

interface ConfigRow {
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

interface NoteRow {
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

interface NavRow {
  book_hash: string;
  version: number;
  toc_json: string;
  sections_json: string;
  updated_at: number;
}

class MockDb {
  books = new Map<string, BooksRow>();
  progress = new Map<string, ProgressRow>();
  configs = new Map<string, ConfigRow>();
  // notes keyed by `${book_hash}::${id}` to model the composite PK.
  notes = new Map<string, NoteRow>();
  navs = new Map<string, NavRow>();
  closed = false;

  // --- helpers -----------------------------------------------------------

  private rowFromUpsertParams(params: unknown[]): BooksRow {
    return {
      hash: params[0] as string,
      format: params[1] as string,
      title: params[2] as string,
      author: params[3] as string,
      source_title: params[4] as string | null,
      meta_hash: params[5] as string | null,
      url: params[6] as string | null,
      file_path: params[7] as string | null,
      cover_image_url: params[8] as string | null,
      group_id: params[9] as string | null,
      group_name: params[10] as string | null,
      tags_json: params[11] as string | null,
      progress_current: params[12] as number | null,
      progress_total: params[13] as number | null,
      reading_status: params[14] as string | null,
      primary_language: params[15] as string | null,
      metadata_json: params[16] as string | null,
      created_at: params[17] as number,
      updated_at: params[18] as number,
      deleted_at: params[19] as number | null,
      uploaded_at: params[20] as number | null,
      downloaded_at: params[21] as number | null,
      cover_downloaded_at: params[22] as number | null,
      synced_at: params[23] as number | null,
      last_updated: params[24] as number | null,
    };
  }

  // --- DatabaseService surface ------------------------------------------

  select = vi.fn(async (sql: string, params: unknown[] = []): Promise<unknown[]> => {
    if (sql.includes('COUNT(*) AS n FROM books')) {
      return [{ n: this.books.size }];
    }
    if (sql.includes('SELECT hash, updated_at FROM books')) {
      return Array.from(this.books.values()).map(({ hash, updated_at }) => ({
        hash,
        updated_at,
      }));
    }
    if (sql.includes('SELECT * FROM books')) {
      const rows = Array.from(this.books.values()).sort((a, b) => b.updated_at - a.updated_at);
      return rows;
    }
    if (sql.includes('SELECT * FROM book_configs')) {
      const [bookHash] = params as [string];
      const row = this.configs.get(bookHash);
      return row ? [row] : [];
    }
    if (sql.includes('SELECT * FROM book_notes')) {
      const [bookHash] = params as [string];
      return Array.from(this.notes.values())
        .filter((n) => n.book_hash === bookHash)
        .sort((a, b) => b.updated_at - a.updated_at);
    }
    if (sql.includes('SELECT * FROM book_navs')) {
      const [bookHash] = params as [string];
      const row = this.navs.get(bookHash);
      return row ? [row] : [];
    }
    throw new Error(`MockDb.select: unhandled SQL: ${sql}`);
  });

  execute = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('INSERT INTO books')) {
      const row = this.rowFromUpsertParams(params);
      this.books.set(row.hash, row);
      return { rowsAffected: 1, lastInsertId: 0 };
    }
    if (sql.includes('INSERT INTO book_progress')) {
      const [book_hash, current, total, updated_at] = params as [string, number, number, number];
      this.progress.set(book_hash, { book_hash, current, total, updated_at });
      return { rowsAffected: 1, lastInsertId: 0 };
    }
    if (sql.includes('DELETE FROM book_progress')) {
      const [hash] = params as [string];
      this.progress.delete(hash);
      return { rowsAffected: 1, lastInsertId: 0 };
    }
    if (sql.includes('INSERT INTO book_configs')) {
      const row: ConfigRow = {
        book_hash: params[0] as string,
        schema_version: params[1] as number | null,
        progress_current: params[2] as number | null,
        progress_total: params[3] as number | null,
        location: params[4] as string | null,
        xpointer: params[5] as string | null,
        config_json: params[6] as string,
        last_synced_at_config: params[7] as number | null,
        last_synced_at_notes: params[8] as number | null,
        last_pushed_at_config: params[9] as number | null,
        last_pushed_at_notes: params[10] as number | null,
        foliate_imported_at: params[11] as number | null,
        updated_at: params[12] as number,
      };
      this.configs.set(row.book_hash, row);
      return { rowsAffected: 1, lastInsertId: 0 };
    }
    if (sql.includes('INSERT INTO book_notes')) {
      const row: NoteRow = {
        book_hash: params[0] as string,
        id: params[1] as string,
        meta_hash: params[2] as string | null,
        type: params[3] as string,
        cfi: params[4] as string,
        xpointer0: params[5] as string | null,
        xpointer1: params[6] as string | null,
        page: params[7] as number | null,
        text: params[8] as string | null,
        style: params[9] as string | null,
        color: params[10] as string | null,
        note: params[11] as string,
        global_flag: params[12] as number | null,
        created_at: params[13] as number,
        updated_at: params[14] as number,
        deleted_at: params[15] as number | null,
      };
      this.notes.set(`${row.book_hash}::${row.id}`, row);
      return { rowsAffected: 1, lastInsertId: 0 };
    }
    if (sql.includes('DELETE FROM book_notes WHERE book_hash = ?')) {
      const [hash] = params as [string];
      let removed = 0;
      for (const k of Array.from(this.notes.keys())) {
        if (k.startsWith(`${hash}::`)) {
          this.notes.delete(k);
          removed += 1;
        }
      }
      return { rowsAffected: removed, lastInsertId: 0 };
    }
    if (sql.includes('INSERT INTO book_navs')) {
      const row: NavRow = {
        book_hash: params[0] as string,
        version: params[1] as number,
        toc_json: params[2] as string,
        sections_json: params[3] as string,
        updated_at: params[4] as number,
      };
      this.navs.set(row.book_hash, row);
      return { rowsAffected: 1, lastInsertId: 0 };
    }
    if (sql.includes('DELETE FROM books')) {
      const [hash] = params as [string];
      const had = this.books.delete(hash);
      this.progress.delete(hash);
      return { rowsAffected: had ? 1 : 0, lastInsertId: 0 };
    }
    throw new Error(`MockDb.execute: unhandled SQL: ${sql}`);
  });

  batch = vi.fn(async (statements: string[]) => {
    // The bootstrap path inlines values into the SQL; run a tiny parser
    // that recognises the INSERT OR IGNORE INTO books form we emit.
    for (const stmt of statements) {
      const m = stmt.match(/VALUES \(([\s\S]*)\)/);
      if (!m) continue;
      const valuesRaw = m[1]!;
      // Split top-level commas (no nested parens / strings expected).
      const parts: string[] = [];
      let buf = '';
      let inStr = false;
      for (let i = 0; i < valuesRaw.length; i++) {
        const ch = valuesRaw[i];
        if (ch === "'") {
          inStr = !inStr;
          buf += ch;
        } else if (ch === ',' && !inStr) {
          parts.push(buf.trim());
          buf = '';
        } else {
          buf += ch;
        }
      }
      if (buf.trim()) parts.push(buf.trim());
      const params = parts.map((p) => {
        if (p === 'NULL') return null;
        if (p.startsWith("'") && p.endsWith("'")) return p.slice(1, -1).replace(/''/g, "'");
        if (/^-?\d+$/.test(p)) return Number(p);
        return p;
      });
      const row = this.rowFromUpsertParams(params);
      // INSERT OR IGNORE: don't overwrite existing.
      if (!this.books.has(row.hash)) this.books.set(row.hash, row);
    }
  });

  close = vi.fn(async () => {
    this.closed = true;
  });
}

// ---------------------------------------------------------------------------
// FileSystem stub — minimal surface that the legacy library.json reader
// (libraryService.loadLibraryBooks → safeLoadJSON → loadJSONFile) actually
// touches: exists / readFile / createDir.
// ---------------------------------------------------------------------------

class MockFs implements Partial<FileSystem> {
  files = new Map<string, string>();

  exists = vi.fn(async (path: string, base: BaseDir) => {
    if (path === '' && base === 'Books') return true;
    return this.files.has(`${base}/${path}`);
  });

  readFile = vi.fn(async (path: string, base: BaseDir, mode: 'text' | 'binary') => {
    if (mode !== 'text') throw new Error('binary not used in test');
    const content = this.files.get(`${base}/${path}`);
    if (content === undefined) throw new Error('ENOENT');
    return content;
  });

  writeFile = vi.fn(async (path: string, base: BaseDir, content: string | Uint8Array) => {
    if (typeof content !== 'string') return;
    this.files.set(`${base}/${path}`, content);
  });

  createDir = vi.fn(async () => {});
  removeFile = vi.fn(async () => {});
  removeDir = vi.fn(async () => {});
  copyFile = vi.fn(async () => {});
  readDir = vi.fn(async (): Promise<FileItem[]> => []);
  stats = vi.fn(
    async (): Promise<FileInfo> => ({
      isFile: true,
      isDirectory: false,
      isSymlink: false,
      size: 0,
      mtime: null,
      atime: null,
      birthtime: null,
    }),
  );
  openFile = vi.fn(async () => new File([''], 'noop'));
  getPrefix = vi.fn(async () => '');
  getImageURL = vi.fn(async () => '');
  // resolvePath is callable but unused by the SQLite repo
  resolvePath = vi.fn(() => ({
    fp: '',
    baseDir: 0,
    basePrefix: async () => '',
  })) as unknown as FileSystem['resolvePath'];
}

// ---------------------------------------------------------------------------
// AppService stub: just needs openDatabase.
// ---------------------------------------------------------------------------

const appServiceFor = (db: MockDb): AppService =>
  ({ openDatabase: vi.fn(async () => db) }) as unknown as AppService;

// Helper to build minimal Books.
const makeBook = (overrides: Partial<Book> & Pick<Book, 'hash'>): Book => ({
  format: 'EPUB',
  title: `T-${overrides.hash}`,
  author: 'A',
  createdAt: 1000,
  updatedAt: 2000,
  ...overrides,
});

describe('SqliteLibraryRepository', () => {
  let db: MockDb;
  let fs: MockFs;
  let app: AppService;
  let cover: ReturnType<typeof vi.fn>;
  let repo: SqliteLibraryRepository;

  beforeEach(() => {
    db = new MockDb();
    fs = new MockFs();
    app = appServiceFor(db);
    cover = vi.fn(async (b: Book) => `cover://${b.hash}`);
    repo = new SqliteLibraryRepository(
      app,
      fs as unknown as FileSystem,
      cover as unknown as (b: Book) => Promise<string>,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('bootstraps from legacy library.json on first load and rehydrates covers', async () => {
    fs.files.set(
      'Books/library.json',
      JSON.stringify([
        makeBook({ hash: 'a', updatedAt: 100 }),
        makeBook({ hash: 'b', updatedAt: 200 }),
      ]),
    );

    const books = await repo.loadLibraryBooks();

    expect(books).toHaveLength(2);
    expect(books.map((b) => b.hash)).toEqual(['b', 'a']); // ORDER BY updated_at DESC
    expect(books[0]!.coverImageUrl).toBe('cover://b');
    expect(db.batch).toHaveBeenCalledTimes(1);
    expect(db.close).toHaveBeenCalled();
    expect(db.books.size).toBe(2);
  });

  it('skips bootstrap when the table is already populated', async () => {
    db.books.set('preexisting', {
      hash: 'preexisting',
      format: 'PDF',
      title: 'Hello',
      author: 'me',
      source_title: null,
      meta_hash: null,
      url: null,
      file_path: null,
      cover_image_url: null,
      group_id: null,
      group_name: null,
      tags_json: null,
      progress_current: null,
      progress_total: null,
      reading_status: null,
      primary_language: null,
      metadata_json: null,
      created_at: 0,
      updated_at: 1,
      deleted_at: null,
      uploaded_at: null,
      downloaded_at: null,
      cover_downloaded_at: null,
      synced_at: null,
      last_updated: null,
    });

    const books = await repo.loadLibraryBooks();

    expect(books).toHaveLength(1);
    expect(books[0]!.hash).toBe('preexisting');
    expect(db.batch).not.toHaveBeenCalled();
  });

  it('saveLibraryBooks upserts new rows and persists progress', async () => {
    await repo.saveLibraryBooks([makeBook({ hash: 'x', updatedAt: 10, progress: [50, 200] })]);

    expect(db.books.get('x')?.title).toBe('T-x');
    expect(db.books.get('x')?.progress_current).toBe(50);
    expect(db.progress.get('x')).toMatchObject({ book_hash: 'x', current: 50, total: 200 });
  });

  it('saveLibraryBooks skips writes when updatedAt did not advance', async () => {
    await repo.saveLibraryBooks([makeBook({ hash: 'x', updatedAt: 10 })]);
    db.execute.mockClear();

    await repo.saveLibraryBooks([makeBook({ hash: 'x', updatedAt: 10 })]);

    // Only the SELECT for diff was issued, no UPSERT executed.
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('saveLibraryBooks updates rows when updatedAt advances', async () => {
    await repo.saveLibraryBooks([makeBook({ hash: 'x', updatedAt: 10, title: 'first' })]);
    await repo.saveLibraryBooks([makeBook({ hash: 'x', updatedAt: 20, title: 'second' })]);

    expect(db.books.get('x')?.title).toBe('second');
    expect(db.books.get('x')?.updated_at).toBe(20);
  });

  it('saveLibraryBooks hard-deletes rows that disappear from the input', async () => {
    await repo.saveLibraryBooks([
      makeBook({ hash: 'a', updatedAt: 10 }),
      makeBook({ hash: 'b', updatedAt: 20 }),
    ]);

    await repo.saveLibraryBooks([makeBook({ hash: 'a', updatedAt: 30 })]);

    expect(db.books.has('a')).toBe(true);
    expect(db.books.has('b')).toBe(false);
    expect(db.progress.has('b')).toBe(false);
  });

  it('soft-deleted rows survive saveLibraryBooks (caller supplies deletedAt)', async () => {
    await repo.saveLibraryBooks([makeBook({ hash: 'a', updatedAt: 10 })]);
    await repo.saveLibraryBooks([makeBook({ hash: 'a', updatedAt: 20, deletedAt: 15 })]);

    expect(db.books.get('a')?.deleted_at).toBe(15);

    // loadLibraryBooks returns soft-deleted rows so backupService /
    // WebDAVSync can see tombstones — matches the JSON backend.
    const loaded = await repo.loadLibraryBooks();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.deletedAt).toBe(15);
  });

  it('drops progress row when progress is removed from the book', async () => {
    await repo.saveLibraryBooks([makeBook({ hash: 'x', updatedAt: 10, progress: [10, 100] })]);
    expect(db.progress.has('x')).toBe(true);

    await repo.saveLibraryBooks([makeBook({ hash: 'x', updatedAt: 20 })]);
    expect(db.progress.has('x')).toBe(false);
  });

  it('round-trips tags and metadata as JSON blobs', async () => {
    const meta = { provider: 'gbooks', identifiers: { isbn: '9' } };
    await repo.saveLibraryBooks([
      makeBook({
        hash: 'x',
        updatedAt: 10,
        tags: ['fiction', 'classic'],
        metadata: meta as unknown as Book['metadata'],
      }),
    ]);

    const [book] = await repo.loadLibraryBooks();
    expect(book?.tags).toEqual(['fiction', 'classic']);
    expect(book?.metadata).toEqual(meta);
  });

  // -------------------------------------------------------------------------
  // BookConfig + BookNotes
  //
  // Same MockDb / MockFs as above. The settings stub only needs
  // `globalViewSettings` populated for the (de)serialiser to round-trip
  // viewSettings overrides; everything else on SystemSettings is unused
  // by the repo.
  // -------------------------------------------------------------------------

  const makeSettings = (
    overrides: Partial<SystemSettings['globalViewSettings']> = {},
  ): SystemSettings =>
    ({
      globalViewSettings: {
        // Only the fields we exercise in the diff/compress path need
        // to exist; everything else `serializeConfig` reads is
        // tolerated as "missing -> not in diff".
        scrolled: false,
        gapPercent: 5,
        ...overrides,
      },
    }) as unknown as SystemSettings;

  const makeNote = (overrides: Partial<BookNote> & Pick<BookNote, 'id'>): BookNote => ({
    type: 'highlight',
    cfi: `epubcfi(/${overrides.id})`,
    note: '',
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  });

  it('loadBookConfig returns the empty default when neither row nor sidecar exist', async () => {
    const book = makeBook({ hash: 'h1' });
    const config = await repo.loadBookConfig(book, makeSettings());

    expect(config.booknotes).toBeUndefined();
    expect(config.viewSettings?.scrolled).toBe(false); // rehydrated from globals
  });

  it('saveBookConfig writes the SQLite row and a byte-identical sidecar', async () => {
    const book = makeBook({ hash: 'h1' });
    const config: BookConfig = {
      schemaVersion: 1,
      progress: [3, 100],
      location: 'epubcfi(/6/4)',
      updatedAt: 1234,
      viewSettings: { scrolled: true } as BookConfig['viewSettings'],
      booknotes: [makeNote({ id: 'n1', text: 'hi', note: 'why?' })],
    };

    await repo.saveBookConfig(book, config, makeSettings());

    // SQLite row reflects the hot-path columns.
    const row = db.configs.get('h1');
    expect(row?.progress_current).toBe(3);
    expect(row?.progress_total).toBe(100);
    expect(row?.location).toBe('epubcfi(/6/4)');
    expect(row?.updated_at).toBe(1234);

    // config_json never inlines booknotes — those go to book_notes.
    const persisted = JSON.parse(row!.config_json) as BookConfig;
    expect(persisted.booknotes).toBeUndefined();
    // The diff-compressed viewSettings only carries non-default fields.
    expect(persisted.viewSettings?.scrolled).toBe(true);
    expect(persisted.viewSettings?.gapPercent).toBeUndefined();

    // Booknote row exists with global_flag normalised.
    expect(db.notes.get('h1::n1')?.note).toBe('why?');
    expect(db.notes.get('h1::n1')?.global_flag).toBe(0);

    // Sidecar mirror: the on-disk file embeds booknotes inline so
    // backup / WebDAV consumers see no behaviour change.
    const sidecar = JSON.parse(fs.files.get('Books/h1/config.json')!) as BookConfig;
    expect(sidecar.booknotes).toHaveLength(1);
    expect(sidecar.booknotes![0]!.id).toBe('n1');
    expect(sidecar.viewSettings?.scrolled).toBe(true);
  });

  it('loadBookConfig re-attaches booknotes from book_notes', async () => {
    const book = makeBook({ hash: 'h1' });
    await repo.saveBookConfig(
      book,
      {
        updatedAt: 1,
        booknotes: [makeNote({ id: 'n1', updatedAt: 100 }), makeNote({ id: 'n2', updatedAt: 200 })],
      } as BookConfig,
      makeSettings(),
    );

    const loaded = await repo.loadBookConfig(book, makeSettings());

    // ORDER BY updated_at DESC.
    expect(loaded.booknotes?.map((n) => n.id)).toEqual(['n2', 'n1']);
  });

  it('saveBookConfig replaces the booknotes set so deletions take effect', async () => {
    const book = makeBook({ hash: 'h1' });
    await repo.saveBookConfig(
      book,
      { updatedAt: 1, booknotes: [makeNote({ id: 'n1' }), makeNote({ id: 'n2' })] } as BookConfig,
      makeSettings(),
    );

    await repo.saveBookConfig(
      book,
      { updatedAt: 2, booknotes: [makeNote({ id: 'n2' })] } as BookConfig,
      makeSettings(),
    );

    expect(db.notes.has('h1::n1')).toBe(false);
    expect(db.notes.has('h1::n2')).toBe(true);
  });

  it('saveBookConfig without settings emits a raw (uncompressed) payload', async () => {
    const book = makeBook({ hash: 'h1' });
    const config: BookConfig = {
      updatedAt: 1,
      // viewSettings.gapPercent matches the global default — when settings
      // are present this would be diffed away; in raw mode it stays.
      viewSettings: { gapPercent: 5, scrolled: false } as BookConfig['viewSettings'],
    };
    await repo.saveBookConfig(book, config);

    const row = db.configs.get('h1');
    const persisted = JSON.parse(row!.config_json) as BookConfig;
    // No diff: both fields survive.
    expect(persisted.viewSettings?.gapPercent).toBe(5);
    expect(persisted.viewSettings?.scrolled).toBe(false);
  });

  it('loadBookConfig bootstraps from legacy sidecar when row is missing', async () => {
    const book = makeBook({ hash: 'h1' });
    const legacy: BookConfig = {
      updatedAt: 999,
      progress: [10, 50],
      booknotes: [makeNote({ id: 'legacy', text: 'old' })],
    } as BookConfig;
    fs.files.set('Books/h1/config.json', JSON.stringify(legacy));

    const loaded = await repo.loadBookConfig(book, makeSettings());

    expect(loaded.progress).toEqual([10, 50]);
    expect(loaded.booknotes?.[0]?.id).toBe('legacy');
    // Bootstrap is observable — the row exists now.
    expect(db.configs.get('h1')?.progress_current).toBe(10);
    expect(db.notes.get('h1::legacy')).toBeDefined();
  });

  it('bootstrap ignores corrupt sidecars instead of crashing', async () => {
    const book = makeBook({ hash: 'h1' });
    fs.files.set('Books/h1/config.json', '{not json');

    const loaded = await repo.loadBookConfig(book, makeSettings());

    // Falls back to the empty default; no row inserted.
    expect(loaded.booknotes).toBeUndefined();
    expect(db.configs.has('h1')).toBe(false);
  });
});

describe('SqliteLibraryRepository — BookNav', () => {
  let db: MockDb;
  let fs: MockFs;
  let repo: SqliteLibraryRepository;

  beforeEach(() => {
    db = new MockDb();
    fs = new MockFs();
    repo = new SqliteLibraryRepository(
      appServiceFor(db),
      fs as unknown as FileSystem,
      async () => 'cover://',
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Mirrors the `BookNav` shape from @/services/nav. We avoid pulling the
  // real type to keep this test independent of the nav-module surface.
  const makeNav = (overrides: Partial<{ version: number }> = {}) => ({
    version: 3,
    toc: [{ label: 'Chapter 1', href: 'c1.xhtml' }],
    sections: { 'c1.xhtml': { id: 'c1.xhtml', fragments: [] } },
    ...overrides,
  });

  it('returns null when no nav row and no sidecar exist', async () => {
    const book = makeBook({ hash: 'h1' });
    const got = await repo.loadBookNav(book);
    expect(got).toBeNull();
    expect(db.navs.size).toBe(0);
  });

  it('saveBookNav writes the SQLite row and a byte-identical sidecar', async () => {
    const book = makeBook({ hash: 'h1' });
    const nav = makeNav();

    await repo.saveBookNav(book, nav);

    const row = db.navs.get('h1');
    expect(row).toBeDefined();
    expect(row!.version).toBe(3);
    expect(JSON.parse(row!.toc_json)).toEqual(nav.toc);
    expect(JSON.parse(row!.sections_json)).toEqual(nav.sections);

    const sidecar = fs.files.get('Books/h1/nav.json');
    expect(sidecar).toBe(JSON.stringify(nav));
  });

  it('loadBookNav reads from SQLite when the row exists', async () => {
    const book = makeBook({ hash: 'h1' });
    const nav = makeNav({ version: 3 });
    await repo.saveBookNav(book, nav);

    const loaded = await repo.loadBookNav(book);
    expect(loaded).toEqual(nav);
  });

  it('loadBookNav bootstraps from a legacy nav.json sidecar on first read', async () => {
    const book = makeBook({ hash: 'h1' });
    const legacy = makeNav({ version: 2 });
    fs.files.set('Books/h1/nav.json', JSON.stringify(legacy));

    const loaded = await repo.loadBookNav(book);

    expect(loaded).toEqual(legacy);
    // Seed is observable: the row exists now and a subsequent load
    // would skip the sidecar entirely.
    expect(db.navs.get('h1')?.version).toBe(2);
  });

  it('loadBookNav returns null for corrupt sidecars (computeBookNav rebuilds)', async () => {
    const book = makeBook({ hash: 'h1' });
    fs.files.set('Books/h1/nav.json', '{not json');

    const loaded = await repo.loadBookNav(book);
    expect(loaded).toBeNull();
    expect(db.navs.has('h1')).toBe(false);
  });

  it('loadBookNav returns null when the parsed payload lacks a version', async () => {
    const book = makeBook({ hash: 'h1' });
    // Valid JSON, wrong shape — matches the existing JSON repo guard
    // (`typeof parsed.version !== 'number'`) so the reader still
    // recomputes the nav from scratch.
    fs.files.set('Books/h1/nav.json', JSON.stringify({ toc: [], sections: {} }));

    const loaded = await repo.loadBookNav(book);
    expect(loaded).toBeNull();
    expect(db.navs.has('h1')).toBe(false);
  });

  it('saveBookNav overwrites a previous row and sidecar', async () => {
    const book = makeBook({ hash: 'h1' });
    await repo.saveBookNav(book, makeNav({ version: 2 }));
    await repo.saveBookNav(book, makeNav({ version: 3 }));

    expect(db.navs.get('h1')?.version).toBe(3);
    const sidecar = JSON.parse(fs.files.get('Books/h1/nav.json')!) as { version: number };
    expect(sidecar.version).toBe(3);
  });
});
