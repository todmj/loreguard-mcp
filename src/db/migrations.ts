import type { Database } from "better-sqlite3";

/**
 * Each migration is a pair: { id, up }. The migration framework records
 * applied IDs in a `migrations` table so we can replay forwards safely.
 * Migrations are append-only — never rewrite history; add a new one.
 */
export interface Migration {
  readonly id: string;
  readonly up: (db: Database) => void;
}

export const MIGRATIONS: ReadonlyArray<Migration> = [
  {
    id: "001-initial-schema",
    up(db) {
      db.exec(`
        CREATE TABLE ideas (
          id              TEXT PRIMARY KEY,
          title           TEXT NOT NULL,
          summary         TEXT NOT NULL,
          body            TEXT NOT NULL,
          author          TEXT,
          team            TEXT,
          confidential    INTEGER NOT NULL DEFAULT 0,
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL,
          last_verified_at TEXT
        );

        CREATE TABLE idea_repos (
          idea_id TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
          repo    TEXT NOT NULL,
          PRIMARY KEY (idea_id, repo)
        );
        CREATE INDEX idx_idea_repos_repo ON idea_repos(repo);

        CREATE TABLE idea_tags (
          idea_id TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
          tag     TEXT NOT NULL,
          PRIMARY KEY (idea_id, tag)
        );
        CREATE INDEX idx_idea_tags_tag ON idea_tags(tag);

        CREATE TABLE events (
          rowid     INTEGER PRIMARY KEY AUTOINCREMENT,
          idea_id   TEXT,
          kind      TEXT NOT NULL,
          ts        TEXT NOT NULL,
          payload   TEXT
        );
        CREATE INDEX idx_events_idea_ts ON events(idea_id, ts);

        -- Full-text search across title / summary / body. Content-rowid'd to
        -- the ideas table so updates stay in sync via triggers below.
        CREATE VIRTUAL TABLE ideas_fts USING fts5(
          title, summary, body,
          tokenize = 'porter unicode61'
        );

        CREATE TRIGGER ideas_fts_ai AFTER INSERT ON ideas BEGIN
          INSERT INTO ideas_fts(rowid, title, summary, body)
            VALUES (new.rowid, new.title, new.summary, new.body);
        END;
        CREATE TRIGGER ideas_fts_ad AFTER DELETE ON ideas BEGIN
          INSERT INTO ideas_fts(ideas_fts, rowid, title, summary, body)
            VALUES('delete', old.rowid, old.title, old.summary, old.body);
        END;
        CREATE TRIGGER ideas_fts_au AFTER UPDATE ON ideas BEGIN
          INSERT INTO ideas_fts(ideas_fts, rowid, title, summary, body)
            VALUES('delete', old.rowid, old.title, old.summary, old.body);
          INSERT INTO ideas_fts(rowid, title, summary, body)
            VALUES (new.rowid, new.title, new.summary, new.body);
        END;
      `);
    },
  },
];

/**
 * Apply any pending migrations in order. Idempotent — safe to call on
 * every `openDb()`.
 */
export function runMigrations(db: Database): { applied: string[] } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id          TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL
    );
  `);
  const seen = new Set<string>(
    (db.prepare("SELECT id FROM migrations").all() as Array<{ id: string }>).map(
      (r) => r.id,
    ),
  );
  const applied: string[] = [];
  const insert = db.prepare(
    "INSERT INTO migrations (id, applied_at) VALUES (?, ?)",
  );
  for (const m of MIGRATIONS) {
    if (seen.has(m.id)) continue;
    db.transaction(() => {
      m.up(db);
      insert.run(m.id, new Date().toISOString());
    })();
    applied.push(m.id);
  }
  return { applied };
}
