import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../types';

export function openDatabase(directory: string): Database {
  mkdirSync(directory, { recursive: true });
  const db = new Database(join(directory, 'feedreader.sqlite'), { create: true, strict: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    db.transaction(() => {
      const version = db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version;
      if (version === 2) return;
      if (version !== 0 && version !== 1) throw new Error('Unsupported database version');
      if (version === 0) createSchema(db);
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS feed_raw_url ON feeds(url);
        CREATE INDEX entry_source ON entries(feedId, sourceId);
        CREATE INDEX entry_url ON entries(feedId, url);
        CREATE INDEX entry_title ON entries(feedId, title) WHERE url = '';
        CREATE TRIGGER feed_duplicate BEFORE INSERT ON feeds
          WHEN EXISTS (SELECT 1 FROM feeds WHERE urlKey = NEW.urlKey)
          BEGIN SELECT RAISE(IGNORE); END;
        CREATE TRIGGER entry_duplicate BEFORE INSERT ON entries WHEN
          EXISTS (SELECT 1 FROM entries WHERE feedId = NEW.feedId AND sourceId = NEW.sourceId AND NEW.sourceId <> '') OR
          EXISTS (SELECT 1 FROM entries WHERE feedId = NEW.feedId AND url = NEW.url AND NEW.url <> '') OR
          EXISTS (SELECT 1 FROM entries WHERE feedId = NEW.feedId AND url = '' AND title = NEW.title AND NEW.url = '' AND NEW.title <> '')
          BEGIN SELECT RAISE(IGNORE); END;
        CREATE TRIGGER feed_delete AFTER DELETE ON feeds
          BEGIN DELETE FROM entries WHERE feedId = OLD.id; END;
        CREATE TRIGGER entry_delete AFTER DELETE ON entries
          BEGIN DELETE FROM states WHERE id = OLD.id; END;
        CREATE TRIGGER state_entry BEFORE INSERT ON states
          WHEN NOT EXISTS (SELECT 1 FROM entries WHERE id = NEW.id)
          BEGIN SELECT RAISE(ABORT, 'Unknown entry id: ' || NEW.id); END;
        PRAGMA user_version = 2;
      `);
    }).immediate();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
export function createSchema(db: Database): void {
  db.exec(`
    CREATE TABLE feeds (id TEXT PRIMARY KEY, url TEXT NOT NULL, urlKey TEXT NOT NULL, label TEXT NOT NULL,
      folderId TEXT, position INTEGER NOT NULL, lastFetched INTEGER, error TEXT, etag TEXT, lastModified TEXT) STRICT;
    CREATE INDEX feed_url ON feeds(urlKey);
    CREATE UNIQUE INDEX feed_raw_url ON feeds(url);
    CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL) STRICT;
    CREATE TABLE entries (id TEXT PRIMARY KEY, sourceId TEXT, feedId TEXT NOT NULL, url TEXT NOT NULL,
      title TEXT NOT NULL, published TEXT NOT NULL, publishedTime REAL NOT NULL) STRICT;
    CREATE INDEX entry_order ON entries(publishedTime DESC);
    CREATE INDEX entry_feed ON entries(feedId, publishedTime DESC);
    CREATE TABLE states (id TEXT PRIMARY KEY, read INTEGER, readAt REAL, starred INTEGER, starredAt REAL) STRICT;
    CREATE INDEX state_starred ON states(starred) WHERE starred = 1;
    CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL) STRICT;
  `);
  db.query('INSERT INTO settings VALUES (1, ?)').run(JSON.stringify(DEFAULT_CONFIG));
  db.exec('PRAGMA user_version = 1');
}
