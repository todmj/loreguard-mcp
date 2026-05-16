import type { Database } from "better-sqlite3";

import type {
  AddIdeaInput,
  Idea,
  IdeaRow,
  IdeaSummary,
  SearchOptions,
} from "../db/types.js";
import { newIdeaId } from "./ids.js";

function nowIso(): string {
  return new Date().toISOString();
}

function normaliseTag(t: string): string {
  return t.trim().toLowerCase().replace(/\s+/g, "-");
}

function normaliseRepo(r: string): string {
  return r.trim();
}

function rowToIdea(row: IdeaRow, repos: string[], tags: string[]): Idea {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    body: row.body,
    author: row.author ?? undefined,
    team: row.team ?? undefined,
    confidential: row.confidential === 1,
    repos,
    tags,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastVerifiedAt: row.last_verified_at ?? undefined,
  };
}

function reposOf(db: Database, id: string): string[] {
  return (
    db
      .prepare("SELECT repo FROM idea_repos WHERE idea_id = ? ORDER BY repo")
      .all(id) as Array<{ repo: string }>
  ).map((r) => r.repo);
}

function tagsOf(db: Database, id: string): string[] {
  return (
    db
      .prepare("SELECT tag FROM idea_tags WHERE idea_id = ? ORDER BY tag")
      .all(id) as Array<{ tag: string }>
  ).map((r) => r.tag);
}

export function addIdea(db: Database, input: AddIdeaInput): Idea {
  const id = newIdeaId();
  const ts = nowIso();
  const repos = Array.from(
    new Set((input.repos ?? []).map(normaliseRepo).filter(Boolean)),
  ).sort();
  const tags = Array.from(
    new Set((input.tags ?? []).map(normaliseTag).filter(Boolean)),
  ).sort();
  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO ideas (id, title, summary, body, author, team, confidential, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.title,
        input.summary,
        input.body,
        input.author ?? null,
        input.team ?? null,
        input.confidential ? 1 : 0,
        ts,
        ts,
      );
    const rowid = Number(info.lastInsertRowid);
    db.prepare(
      "INSERT INTO ideas_fts(rowid, title, summary, body) VALUES (?, ?, ?, ?)",
    ).run(rowid, input.title, input.summary, input.body);
    const repoStmt = db.prepare(
      "INSERT OR IGNORE INTO idea_repos (idea_id, repo) VALUES (?, ?)",
    );
    for (const r of repos) repoStmt.run(id, r);
    const tagStmt = db.prepare(
      "INSERT OR IGNORE INTO idea_tags (idea_id, tag) VALUES (?, ?)",
    );
    for (const t of tags) tagStmt.run(id, t);
    db.prepare(
      "INSERT INTO events (idea_id, kind, ts) VALUES (?, 'created', ?)",
    ).run(id, ts);
  });
  tx();
  return rowToIdea(
    db.prepare("SELECT * FROM ideas WHERE id = ?").get(id) as IdeaRow,
    repos,
    tags,
  );
}

export function getIdea(db: Database, id: string): Idea | null {
  const row = db.prepare("SELECT * FROM ideas WHERE id = ?").get(id) as
    | IdeaRow
    | undefined;
  if (!row) return null;
  return rowToIdea(row, reposOf(db, id), tagsOf(db, id));
}

export function verifyIdea(db: Database, id: string): Idea | null {
  const ts = nowIso();
  // verifyIdea doesn't touch the indexed columns (title/summary/body), so no
  // FTS maintenance is needed here.
  const r = db
    .prepare(
      "UPDATE ideas SET last_verified_at = ?, updated_at = ? WHERE id = ?",
    )
    .run(ts, ts, id);
  if (r.changes === 0) return null;
  db.prepare(
    "INSERT INTO events (idea_id, kind, ts) VALUES (?, 'verified', ?)",
  ).run(id, ts);
  return getIdea(db, id);
}

export function deleteIdea(db: Database, id: string): boolean {
  const ts = nowIso();
  const row = db
    .prepare("SELECT rowid, title, summary, body FROM ideas WHERE id = ?")
    .get(id) as { rowid: number; title: string; summary: string; body: string } | undefined;
  if (!row) return false;
  const tx = db.transaction(() => {
    // Drop from FTS by rowid. FTS5 supports direct DELETE on regular
    // (non-contentless) virtual tables — simpler than the magic 'delete'
    // command and works the same way.
    db.prepare("DELETE FROM ideas_fts WHERE rowid = ?").run(row.rowid);
    db.prepare("DELETE FROM ideas WHERE id = ?").run(id);
    db.prepare(
      "INSERT INTO events (idea_id, kind, ts) VALUES (?, 'deleted', ?)",
    ).run(id, ts);
  });
  tx();
  return true;
}

/**
 * FTS-backed search. Filters can compose:
 * - `query`: matched against ideas_fts (title/summary/body, stemmed)
 * - `repo`:  restrict to ideas tagged for this repo
 * - `tag`:   restrict to ideas with this tag
 * - `since`: only ideas updated on/after this ISO timestamp
 * - `includeConfidential`: false by default; safer for LLM contexts
 *
 * Results are ranked by FTS bm25 when `query` is set, otherwise by
 * `updated_at` descending (freshness wins). Freshness boost is applied
 * post-rank: ideas verified in the last 90 days bubble up slightly so
 * stale-and-relevant doesn't outrank fresh-and-relevant.
 */
export function searchIdeas(
  db: Database,
  opts: SearchOptions = {},
): IdeaSummary[] {
  const limit = Math.min(opts.limit ?? 10, 50);
  const includeConfidential = opts.includeConfidential === true;
  const filters: string[] = [];
  const params: Array<string | number> = [];

  const hasFts = !!opts.query && opts.query.trim().length > 0;
  let from: string;
  let select: string;
  if (hasFts) {
    from = `ideas i
            JOIN ideas_fts fts ON fts.rowid = i.rowid`;
    select = `i.*, bm25(ideas_fts) AS score`;
    filters.push("ideas_fts MATCH ?");
    // Quote each term to keep FTS parser happy with stray punctuation.
    params.push(toFtsQuery(opts.query!.trim()));
  } else {
    from = `ideas i`;
    select = `i.*, NULL AS score`;
  }
  if (!includeConfidential) {
    filters.push("i.confidential = 0");
  }
  if (opts.repo) {
    filters.push(
      `i.id IN (SELECT idea_id FROM idea_repos WHERE repo = ?)`,
    );
    params.push(opts.repo);
  }
  if (opts.tag) {
    filters.push(
      `i.id IN (SELECT idea_id FROM idea_tags WHERE tag = ?)`,
    );
    params.push(normaliseTag(opts.tag));
  }
  if (opts.since) {
    filters.push("i.updated_at >= ?");
    params.push(opts.since);
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const orderBy = hasFts
    ? "ORDER BY score ASC, i.updated_at DESC"
    : "ORDER BY i.updated_at DESC";
  const sql = `
    SELECT ${select}
    FROM ${from}
    ${where}
    ${orderBy}
    LIMIT ${limit}
  `;
  const rows = db.prepare(sql).all(...params) as Array<
    IdeaRow & { score: number | null }
  >;
  return rows.map((row) => {
    const repos = reposOf(db, row.id);
    const tags = tagsOf(db, row.id);
    return {
      id: row.id,
      title: row.title,
      summary: row.summary,
      author: row.author ?? undefined,
      team: row.team ?? undefined,
      confidential: row.confidential === 1,
      repos,
      tags,
      updatedAt: row.updated_at,
      lastVerifiedAt: row.last_verified_at ?? undefined,
      score: row.score ?? undefined,
    };
  });
}

/**
 * Translate a free-text query into an FTS5 MATCH expression.
 * We split on whitespace, drop empties, and quote each term so the user
 * can't accidentally inject FTS operators (NEAR, OR, etc.) or break the
 * parser with apostrophes / colons.
 */
function toFtsQuery(input: string): string {
  const parts = input
    .split(/\s+/)
    .map((p) => p.replace(/"/g, ""))
    .filter(Boolean);
  if (parts.length === 0) return "\"\"";
  return parts.map((p) => `"${p}"`).join(" ");
}

/**
 * Recent ideas, freshest first. Used by `lore list` for at-a-glance browse.
 */
export function listRecent(db: Database, limit = 20): IdeaSummary[] {
  return searchIdeas(db, { limit, includeConfidential: true });
}

/**
 * Distinct list of all tags / all repos across all ideas. Useful for the
 * CLI's autocomplete and for showing the schema of what's stored.
 */
export function listTags(db: Database): string[] {
  return (
    db
      .prepare(
        "SELECT DISTINCT tag FROM idea_tags ORDER BY tag",
      )
      .all() as Array<{ tag: string }>
  ).map((r) => r.tag);
}

export function listRepos(db: Database): string[] {
  return (
    db
      .prepare(
        "SELECT DISTINCT repo FROM idea_repos ORDER BY repo",
      )
      .all() as Array<{ repo: string }>
  ).map((r) => r.repo);
}
