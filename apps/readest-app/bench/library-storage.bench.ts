import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '@tursodatabase/database';
import { avg, type Bench, type BenchResult } from './lib.ts';

/**
 * library-storage benchmark.
 *
 * Compares the current "library.json + per-hash config.json" persistence layer
 * against a SQLite (Turso) replacement on the four operations that dominate
 * real-world Readest usage:
 *
 *   1. Cold start         — load all books into memory
 *   2. Progress update    — bump current page on a single book
 *   3. Batch import       — register N freshly-imported books
 *   4. Note update        — touch one annotation inside one book
 *
 * Each scenario runs both backends against an in-memory-equivalent corpus of
 * `LIBRARY_SIZE` books. JSON path uses a real tmp directory because that's what
 * production hits; SQLite path uses ":memory:" because Turso's WAL doesn't
 * affect the read/UPDATE numbers we care about and we don't want disk variance
 * polluting the comparison. Both are measured with the same `avg(reps, warmup)`
 * harness so the page cache is warm for both.
 */

const LIBRARY_SIZE = 1000;
const NOTES_PER_BOOK = 50;

interface BookRow {
  hash: string;
  title: string;
  author: string;
  format: string;
  group_name: string;
  progress_current: number;
  progress_total: number;
  reading_status: string;
  created_at: number;
  updated_at: number;
  metadata_json: string;
  tags_json: string;
}

interface NoteRow {
  id: string;
  type: string;
  cfi: string;
  text: string;
  note: string;
  created_at: number;
  updated_at: number;
}

function makeBook(i: number): BookRow {
  // Realistic-looking metadata with some bulk so the JSON is representative.
  // Real Readest books carry a parsed BookMetadata object (~1-3KB) plus the
  // per-book metadata extracted from the EPUB (description, identifiers,
  // contributors). This shape mirrors that.
  const metadata = {
    identifier: `urn:isbn:978${1000000000 + i}`,
    title: `Book Title ${i}`,
    author: [{ name: `Author ${i % 50}` }],
    publisher: `Publisher ${i % 20}`,
    language: i % 3 === 0 ? 'zh' : 'en',
    pubdate: new Date(2000 + (i % 25), i % 12, (i % 28) + 1).toISOString(),
    description:
      `A reasonably long description for book ${i} that describes its contents in some detail, simulating the metadata typically found in EPUB files. `.repeat(
        3,
      ),
    rights: 'All rights reserved',
    subject: ['Fiction', 'Literature', `Tag${i % 10}`],
  };
  return {
    hash: `hash${i.toString(16).padStart(16, '0')}`,
    title: `Book Title ${i}`,
    author: `Author ${i % 50}`,
    format: i % 5 === 0 ? 'PDF' : 'EPUB',
    group_name: i % 7 === 0 ? `Group/${i % 4}` : '',
    progress_current: (i * 13) % 500,
    progress_total: 500 + (i % 200),
    reading_status: ['unread', 'reading', 'finished'][i % 3]!,
    created_at: 1700000000000 + i * 1000,
    updated_at: 1700000000000 + i * 1000,
    metadata_json: JSON.stringify(metadata),
    tags_json: JSON.stringify([`tag${i % 10}`, `tag${(i + 3) % 10}`]),
  };
}

function makeNotes(bookHash: string, n: number): NoteRow[] {
  const out: NoteRow[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `${bookHash}-note-${i}`,
      type: i % 5 === 0 ? 'bookmark' : 'annotation',
      cfi: `epubcfi(/6/${(i + 2) * 2}!/4/2/${i * 4 + 1}:0)`,
      text: `Selected text ${i} from book ${bookHash}`,
      note: i % 3 === 0 ? `User note ${i}` : '',
      created_at: 1700000000000 + i * 100,
      updated_at: 1700000000000 + i * 100,
    });
  }
  return out;
}

/* ─────────────────────────── JSON path (current Readest) ─────────────────── */

interface JsonHarness {
  rootDir: string;
  cleanup(): void;
}

/** Mirror of services/persistence safeSaveJSON: write tmp + atomic rename. */
function safeSaveJSON(filePath: string, data: unknown): void {
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, filePath);
}

function setupJsonLibrary(): JsonHarness {
  const rootDir = mkdtempSync(join(tmpdir(), 'readest-bench-json-'));
  const booksDir = join(rootDir, 'Books');
  mkdirSync(booksDir, { recursive: true });

  const books: BookRow[] = [];
  for (let i = 0; i < LIBRARY_SIZE; i++) {
    const b = makeBook(i);
    books.push(b);
    const hashDir = join(booksDir, b.hash);
    mkdirSync(hashDir, { recursive: true });
    // Each book gets a config.json with notes, view-settings overrides, and
    // sync timestamps — mirrors what bookService writes today.
    const config = {
      schemaVersion: 1,
      bookHash: b.hash,
      progress: [b.progress_current, b.progress_total],
      location: `epubcfi(/6/${(i % 30) * 2}!/4/2/2:0)`,
      booknotes: makeNotes(b.hash, NOTES_PER_BOOK),
      viewSettings: {
        defaultFontSize: 16,
        lineHeight: 1.6,
        fullJustification: true,
      },
      lastSyncedAtConfig: 1700000000000 + i * 1000,
      updatedAt: 1700000000000 + i * 1000,
    };
    writeFileSync(join(hashDir, 'config.json'), JSON.stringify(config));
  }
  safeSaveJSON(join(booksDir, 'library.json'), books);

  return {
    rootDir,
    cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
  };
}

function jsonLoadAll(rootDir: string): BookRow[] {
  // What loadLibraryBooks does today: read library.json, JSON.parse it.
  // (Cover URL generation is excluded from the bench — both backends would
  // need to do the same thing on top, so it cancels out.)
  return JSON.parse(readFileSync(join(rootDir, 'Books', 'library.json'), 'utf8'));
}

function jsonUpdateProgress(rootDir: string, hash: string, current: number): void {
  // Today's path: rewrite the entire library.json AND the per-book config.json.
  const libPath = join(rootDir, 'Books', 'library.json');
  const cfgPath = join(rootDir, 'Books', hash, 'config.json');

  const books = JSON.parse(readFileSync(libPath, 'utf8')) as BookRow[];
  const idx = books.findIndex((b) => b.hash === hash);
  if (idx >= 0) {
    books[idx]!.progress_current = current;
    books[idx]!.updated_at = Date.now();
  }
  safeSaveJSON(libPath, books);

  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.progress = [current, cfg.progress[1]];
  cfg.updatedAt = Date.now();
  safeSaveJSON(cfgPath, cfg);
}

function jsonBatchImport(rootDir: string, newBooks: BookRow[]): void {
  // updateBooks → saveLibraryBooks: full rewrite per call, called once after
  // the batch finishes. We test the 1-rewrite-per-batch best-case (current
  // code does *not* rewrite per-book inside a batch).
  const libPath = join(rootDir, 'Books', 'library.json');
  const existing = JSON.parse(readFileSync(libPath, 'utf8')) as BookRow[];
  const merged = Array.from(new Map([...existing, ...newBooks].map((b) => [b.hash, b])).values());
  safeSaveJSON(libPath, merged);

  // And a config.json per new book.
  for (const b of newBooks) {
    const dir = join(rootDir, 'Books', b.hash);
    mkdirSync(dir, { recursive: true });
    safeSaveJSON(join(dir, 'config.json'), {
      schemaVersion: 1,
      bookHash: b.hash,
      progress: [0, 0],
      booknotes: [],
      updatedAt: Date.now(),
    });
  }
}

function jsonUpdateNote(rootDir: string, hash: string, noteId: string): void {
  // Today: rewrite the entire config.json for that book.
  const cfgPath = join(rootDir, 'Books', hash, 'config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const note = cfg.booknotes.find((n: NoteRow) => n.id === noteId);
  if (note) {
    note.note = `Edited at ${Date.now()}`;
    note.updated_at = Date.now();
    cfg.updatedAt = Date.now();
  }
  safeSaveJSON(cfgPath, cfg);
}

/* ─────────────────────────── SQLite path (proposed) ──────────────────────── */

interface SqliteHarness {
  db: Awaited<ReturnType<typeof connect>>;
  cleanup(): Promise<void>;
}

async function setupSqliteLibrary(dbPath: string): Promise<SqliteHarness> {
  // Use a real file so fsync cost is included — production SQLite always pays
  // it on COMMIT, and we want the comparison vs JSON's atomic rename to be
  // apples-to-apples (rename on APFS is also a sync operation).
  const db = await connect(dbPath, {});
  // Subset of the proposed schema (P1 surface): books + book_progress +
  // book_notes. Same indexes as the design doc. Keep this in sync with the
  // schema-migration design otherwise the numbers stop being meaningful.
  await db.exec(`
    CREATE TABLE books (
      hash TEXT PRIMARY KEY,
      meta_hash TEXT,
      format TEXT NOT NULL,
      title TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT '',
      group_name TEXT,
      tags_json TEXT,
      progress_current INTEGER,
      progress_total INTEGER,
      reading_status TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      metadata_json TEXT
    );
    CREATE INDEX idx_books_updated_at ON books(updated_at);
    CREATE INDEX idx_books_deleted_at ON books(deleted_at);

    CREATE TABLE book_notes (
      book_hash TEXT NOT NULL,
      id TEXT NOT NULL,
      type TEXT NOT NULL,
      cfi TEXT NOT NULL,
      text TEXT,
      note TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      PRIMARY KEY (book_hash, id)
    );
    CREATE INDEX idx_notes_updated_at ON book_notes(updated_at);
  `);

  // Seed the library in a single transaction.
  await db.exec('BEGIN');
  const insertBook = await db.prepare(
    `INSERT INTO books (hash, format, title, author, group_name, tags_json,
                        progress_current, progress_total, reading_status,
                        created_at, updated_at, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertNote = await db.prepare(
    `INSERT INTO book_notes (book_hash, id, type, cfi, text, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < LIBRARY_SIZE; i++) {
    const b = makeBook(i);
    await insertBook.run(
      b.hash,
      b.format,
      b.title,
      b.author,
      b.group_name,
      b.tags_json,
      b.progress_current,
      b.progress_total,
      b.reading_status,
      b.created_at,
      b.updated_at,
      b.metadata_json,
    );
    for (const n of makeNotes(b.hash, NOTES_PER_BOOK)) {
      await insertNote.run(b.hash, n.id, n.type, n.cfi, n.text, n.note, n.created_at, n.updated_at);
    }
  }
  await db.exec('COMMIT');

  return {
    db,
    cleanup: async () => {
      await db.close();
    },
  };
}

/* ───────────────────────────────── runner ────────────────────────────────── */

export default {
  name: 'library-storage',
  description:
    'JSON (library.json + per-hash config.json) vs SQLite for the four hot Readest persistence ops.',

  async run(): Promise<BenchResult[]> {
    const results: BenchResult[] = [];

    // ── Setup both backends ────────────────────────────────────────────────
    const jsonH = setupJsonLibrary();
    const dbDir = mkdtempSync(join(tmpdir(), 'readest-bench-sqlite-'));
    const dbPath = join(dbDir, 'library.db');
    const sqliteH = await setupSqliteLibrary(dbPath);
    const { db } = sqliteH;
    // Production-equivalent durability settings.
    await db.exec('PRAGMA journal_mode = WAL');
    await db.exec('PRAGMA synchronous = NORMAL');
    await db.exec('PRAGMA temp_store = MEMORY');

    // Sanity check: both backends agree on row count.
    const countStmt = await db.prepare('SELECT count(*) AS c FROM books');
    const sqliteCount = (await countStmt.get()) as {
      c: number;
    };
    const jsonCount = jsonLoadAll(jsonH.rootDir).length;
    if (sqliteCount.c !== LIBRARY_SIZE || jsonCount !== LIBRARY_SIZE) {
      throw new Error(
        `seed mismatch: sqlite=${sqliteCount.c} json=${jsonCount} expected=${LIBRARY_SIZE}`,
      );
    }

    try {
      // ── 1a. Cold-start load (full library only) ──────────────────────────
      // JSON: read + parse library.json
      // SQLite (full): SELECT * — equivalent rows to JSON path
      // SQLite (lean): SELECT only library-grid display columns; defer
      //                 metadata_json/tags_json to lazy fetch when the user
      //                 actually opens a book detail. This is the realistic
      //                 SQLite migration shape — Readest's grid never reads
      //                 metadata.description on the bookshelf view.
      const jsonLoad = await avg(async () => {
        jsonLoadAll(jsonH.rootDir);
      }, 20);
      const sqliteLoadStmt = await db.prepare('SELECT * FROM books WHERE deleted_at IS NULL');
      const sqliteLoad = await avg(async () => {
        await sqliteLoadStmt.all();
      }, 20);
      const sqliteLeanStmt = await db.prepare(
        `SELECT hash, format, title, author, group_name, progress_current,
                progress_total, reading_status, created_at, updated_at
           FROM books
          WHERE deleted_at IS NULL`,
      );
      const sqliteLean = await avg(async () => {
        await sqliteLeanStmt.all();
      }, 20);
      results.push({ scenario: 'load library only — JSON', unit: 'ms', value: jsonLoad });
      results.push({
        scenario: 'load library only — SQLite (full row)',
        unit: 'ms',
        value: sqliteLoad,
        meta: { vsJson: `${(jsonLoad / sqliteLoad).toFixed(2)}x` },
      });
      results.push({
        scenario: 'load library only — SQLite (grid cols)',
        unit: 'ms',
        value: sqliteLean,
        meta: { vsJson: `${(jsonLoad / sqliteLean).toFixed(2)}x` },
      });

      // ── 1b. Open one book (load library + read its config) ───────────────
      // This is the actual "user opens the app and taps a book" path. JSON
      // pays library.json parse + 1 config.json parse; SQLite pays 1 SELECT
      // for books + 1 SELECT for that book's notes.
      const openTargetIdx = Math.floor(LIBRARY_SIZE * 0.7);
      const openTargetHash = makeBook(openTargetIdx).hash;
      const jsonOpen = await avg(async () => {
        jsonLoadAll(jsonH.rootDir);
        JSON.parse(
          readFileSync(join(jsonH.rootDir, 'Books', openTargetHash, 'config.json'), 'utf8'),
        );
      }, 20);
      const sqliteOpenNotesStmt = await db.prepare(
        'SELECT * FROM book_notes WHERE book_hash = ? AND deleted_at IS NULL',
      );
      const sqliteOpen = await avg(async () => {
        await sqliteLoadStmt.all();
        await sqliteOpenNotesStmt.all(openTargetHash);
      }, 20);
      results.push({ scenario: 'load + open 1 book — JSON', unit: 'ms', value: jsonOpen });
      results.push({
        scenario: 'load + open 1 book — SQLite',
        unit: 'ms',
        value: sqliteOpen,
        meta: { speedup: `${(jsonOpen / sqliteOpen).toFixed(1)}x` },
      });

      // ── 2. Single progress update ────────────────────────────────────────
      // JSON: rewrite library.json + rewrite that book's config.json
      // SQLite: UPDATE one row in books (progress is duplicated in book_progress
      //         in the full schema; for P1 we update the cached fields on books).
      let progressCounter = 1;
      const targetHash = makeBook(Math.floor(LIBRARY_SIZE / 2)).hash;
      const jsonProg = await avg(
        async () => {
          jsonUpdateProgress(jsonH.rootDir, targetHash, progressCounter++);
        },
        30,
        5,
      );
      const updateStmt = await db.prepare(
        'UPDATE books SET progress_current = ?, updated_at = ? WHERE hash = ?',
      );
      const sqliteProg = await avg(
        async () => {
          await updateStmt.run(progressCounter++, Date.now(), targetHash);
        },
        30,
        5,
      );
      results.push({ scenario: 'progress update — JSON', unit: 'ms', value: jsonProg });
      results.push({
        scenario: 'progress update — SQLite',
        unit: 'ms',
        value: sqliteProg,
        meta: { speedup: `${(jsonProg / sqliteProg).toFixed(1)}x` },
      });

      // ── 3. Batch import 100 new books ────────────────────────────────────
      // JSON: full library.json rewrite + 100 new config.json files.
      // SQLite: 100 INSERTs in a single transaction.
      let importBatch = 0;
      const jsonImport = await avg(
        async () => {
          const newBooks: BookRow[] = [];
          for (let i = 0; i < 100; i++) {
            newBooks.push(makeBook(LIBRARY_SIZE + importBatch * 100 + i));
          }
          jsonBatchImport(jsonH.rootDir, newBooks);
          importBatch++;
        },
        5,
        1,
      );

      const sqliteImportInsert = await db.prepare(
        `INSERT OR REPLACE INTO books (hash, format, title, author, group_name, tags_json,
                                       progress_current, progress_total, reading_status,
                                       created_at, updated_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      let sqlImportBatch = 0;
      const sqliteImport = await avg(
        async () => {
          await db.exec('BEGIN');
          for (let i = 0; i < 100; i++) {
            const b = makeBook(2 * LIBRARY_SIZE + sqlImportBatch * 100 + i);
            await sqliteImportInsert.run(
              b.hash,
              b.format,
              b.title,
              b.author,
              b.group_name,
              b.tags_json,
              b.progress_current,
              b.progress_total,
              b.reading_status,
              b.created_at,
              b.updated_at,
              b.metadata_json,
            );
          }
          await db.exec('COMMIT');
          sqlImportBatch++;
        },
        5,
        1,
      );
      results.push({ scenario: 'batch import 100 — JSON', unit: 'ms', value: jsonImport });
      results.push({
        scenario: 'batch import 100 — SQLite',
        unit: 'ms',
        value: sqliteImport,
        meta: { speedup: `${(jsonImport / sqliteImport).toFixed(1)}x` },
      });

      // ── 4. Update one note ───────────────────────────────────────────────
      // JSON: rewrite the entire config.json for that book.
      // SQLite: UPDATE one row in book_notes.
      const noteTargetHash = makeBook(Math.floor(LIBRARY_SIZE / 3)).hash;
      const noteTargetId = `${noteTargetHash}-note-${Math.floor(NOTES_PER_BOOK / 2)}`;
      const jsonNote = await avg(
        async () => {
          jsonUpdateNote(jsonH.rootDir, noteTargetHash, noteTargetId);
        },
        30,
        5,
      );
      const noteUpdateStmt = await db.prepare(
        'UPDATE book_notes SET note = ?, updated_at = ? WHERE book_hash = ? AND id = ?',
      );
      const sqliteNote = await avg(
        async () => {
          await noteUpdateStmt.run('edited', Date.now(), noteTargetHash, noteTargetId);
        },
        30,
        5,
      );
      results.push({ scenario: 'update one note — JSON', unit: 'ms', value: jsonNote });
      results.push({
        scenario: 'update one note — SQLite',
        unit: 'ms',
        value: sqliteNote,
        meta: { speedup: `${(jsonNote / sqliteNote).toFixed(1)}x` },
      });
    } finally {
      jsonH.cleanup();
      await sqliteH.cleanup();
      rmSync(dbDir, { recursive: true, force: true });
    }

    return results;
  },
} satisfies Bench;
