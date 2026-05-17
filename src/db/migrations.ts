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
        CREATE TABLE lore (
          id                 TEXT PRIMARY KEY,
          title              TEXT NOT NULL,
          summary            TEXT NOT NULL,
          body               TEXT NOT NULL,
          author             TEXT,
          team               TEXT,
          -- R1+ lifecycle: 'draft' (agent-created, awaiting human approval),
          -- 'active' (canonical), 'deprecated' (still findable with flag,
          -- but not surfaced by default), 'superseded' (replaced — see
          -- superseded_by). Default is 'active' because the migration
          -- targets the human CLI; the suggest_lore MCP tool overrides to
          -- 'draft' explicitly at write time.
          status             TEXT NOT NULL DEFAULT 'active'
            CHECK (status IN ('draft','active','deprecated','superseded')),
          -- Source / provenance URL: PR, ADR, ticket, incident permalink.
          -- A note without a source is treated as lower-trust.
          source             TEXT,
          -- ISO date string. When set + in the past, search marks the
          -- result as stale and surfaces a warning.
          review_after       TEXT,
          -- Subjective trust signal. Default 'medium' so agents that
          -- suggest_lore without specifying don't claim authority.
          confidence         TEXT NOT NULL DEFAULT 'medium'
            CHECK (confidence IN ('low','medium','high')),
          -- When non-null, this lore record is replaced by another id.
          -- Hidden from default search; surfaces only via getLore() or
          -- includeSuperseded flag.
          superseded_by      TEXT,
          -- Retrieval guard, not data-loss-prevention. Excluded from
          -- search unless includeRestricted is explicitly passed.
          restricted         INTEGER NOT NULL DEFAULT 0,
          created_at         TEXT NOT NULL,
          updated_at         TEXT NOT NULL,
          last_verified_at   TEXT
        );

        CREATE TABLE lore_repos (
          lore_id TEXT NOT NULL REFERENCES lore(id) ON DELETE CASCADE,
          repo    TEXT NOT NULL,
          PRIMARY KEY (lore_id, repo)
        );
        CREATE INDEX idx_lore_repos_repo ON lore_repos(repo);

        CREATE TABLE lore_tags (
          lore_id TEXT NOT NULL REFERENCES lore(id) ON DELETE CASCADE,
          tag     TEXT NOT NULL,
          PRIMARY KEY (lore_id, tag)
        );
        CREATE INDEX idx_lore_tags_tag ON lore_tags(tag);

        CREATE TABLE events (
          rowid     INTEGER PRIMARY KEY AUTOINCREMENT,
          lore_id   TEXT,
          kind      TEXT NOT NULL,
          ts        TEXT NOT NULL,
          payload   TEXT
        );
        CREATE INDEX idx_events_lore_ts ON events(lore_id, ts);

        -- Full-text search across title / summary / body. FTS maintenance
        -- is done in TypeScript (see core/lore.ts) rather than via SQL
        -- triggers — predictable, debuggable, no FTS5 'delete'-magic
        -- gotchas when WAL + transactions overlap.
        CREATE VIRTUAL TABLE lore_fts USING fts5(
          title, summary, body,
          tokenize = 'porter unicode61'
        );
      `);
    },
  },
  {
    // NOTE: 002-conflicts-with lands on a sibling branch
    // (feature/conflict-records); when both merge, this 003 sits cleanly
    // after it. Migration order is array-order with idempotency by id.
    id: "003-absence-markers",
    up(db) {
      // Verified-absence: record "we checked, the team has no policy
      // on this — don't re-search for 30 days". When search_lore
      // returns zero hits AND a matching marker is active, the
      // response includes the marker so the next agent knows it's an
      // acknowledged gap, not an oversight. Low-stakes, no review
      // gate, self-expiring — distinct from drafts.
      db.exec(`
        CREATE TABLE absence_markers (
          id            TEXT PRIMARY KEY,
          -- Normalised at write time: trim → lowercase → split on
          -- whitespace → sort tokens → join with single space. Two
          -- queries differing only by word order share a marker.
          query         TEXT NOT NULL,
          repo          TEXT,
          reason        TEXT NOT NULL,
          recorded_at   TEXT NOT NULL,
          expires_at    TEXT NOT NULL,
          recorded_by   TEXT NOT NULL
        );
        CREATE INDEX idx_absence_query ON absence_markers(query);
        CREATE INDEX idx_absence_expires ON absence_markers(expires_at);
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
