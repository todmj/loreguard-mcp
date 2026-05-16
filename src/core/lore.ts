import type { Database } from "better-sqlite3";

import type {
  AddLoreInput,
  Lore,
  LoreConfidence,
  LoreRow,
  LoreStatus,
  LoreSummary,
  SearchOptions,
} from "../db/types.js";
import { newIdeaId as newLoreId } from "./ids.js";

function nowIso(): string {
  return new Date().toISOString();
}

function normaliseTag(t: string): string {
  return t.trim().toLowerCase().replace(/\s+/g, "-");
}

function normaliseRepo(r: string): string {
  return r.trim();
}

function isStale(reviewAfter: string | null): boolean {
  if (!reviewAfter) return false;
  return new Date(reviewAfter).getTime() < Date.now();
}

function rowToLore(row: LoreRow, repos: string[], tags: string[]): Lore {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    body: row.body,
    author: row.author ?? undefined,
    team: row.team ?? undefined,
    status: row.status,
    source: row.source ?? undefined,
    reviewAfter: row.review_after ?? undefined,
    confidence: row.confidence,
    supersededBy: row.superseded_by ?? undefined,
    restricted: row.restricted === 1,
    repos,
    tags,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastVerifiedAt: row.last_verified_at ?? undefined,
  };
}

function rowToSummary(
  row: LoreRow,
  repos: string[],
  tags: string[],
  score?: number,
): LoreSummary {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    author: row.author ?? undefined,
    team: row.team ?? undefined,
    status: row.status,
    source: row.source ?? undefined,
    confidence: row.confidence,
    restricted: row.restricted === 1,
    repos,
    tags,
    updatedAt: row.updated_at,
    lastVerifiedAt: row.last_verified_at ?? undefined,
    stale: isStale(row.review_after),
    score,
  };
}

function reposOf(db: Database, id: string): string[] {
  return (
    db
      .prepare("SELECT repo FROM lore_repos WHERE lore_id = ? ORDER BY repo")
      .all(id) as Array<{ repo: string }>
  ).map((r) => r.repo);
}

function tagsOf(db: Database, id: string): string[] {
  return (
    db
      .prepare("SELECT tag FROM lore_tags WHERE lore_id = ? ORDER BY tag")
      .all(id) as Array<{ tag: string }>
  ).map((r) => r.tag);
}

/**
 * Internal insert path shared by addLore (status='active') and
 * suggestLore (status='draft'). Callers pick the lifecycle default;
 * everything else is symmetric.
 */
function insertLore(
  db: Database,
  input: AddLoreInput,
  status: LoreStatus,
): Lore {
  const id = newLoreId();
  const ts = nowIso();
  const repos = Array.from(
    new Set((input.repos ?? []).map(normaliseRepo).filter(Boolean)),
  ).sort();
  const tags = Array.from(
    new Set((input.tags ?? []).map(normaliseTag).filter(Boolean)),
  ).sort();
  const confidence: LoreConfidence = input.confidence ?? "medium";
  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO lore (
          id, title, summary, body, author, team,
          status, source, review_after, confidence,
          superseded_by, restricted,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.title,
        input.summary,
        input.body,
        input.author ?? null,
        input.team ?? null,
        status,
        input.source ?? null,
        input.reviewAfter ?? null,
        confidence,
        null,
        input.restricted ? 1 : 0,
        ts,
        ts,
      );
    const rowid = Number(info.lastInsertRowid);
    db.prepare(
      "INSERT INTO lore_fts(rowid, title, summary, body) VALUES (?, ?, ?, ?)",
    ).run(rowid, input.title, input.summary, input.body);
    const repoStmt = db.prepare(
      "INSERT OR IGNORE INTO lore_repos (lore_id, repo) VALUES (?, ?)",
    );
    for (const r of repos) repoStmt.run(id, r);
    const tagStmt = db.prepare(
      "INSERT OR IGNORE INTO lore_tags (lore_id, tag) VALUES (?, ?)",
    );
    for (const t of tags) tagStmt.run(id, t);
    db.prepare("INSERT INTO events (lore_id, kind, ts) VALUES (?, ?, ?)").run(
      id,
      status === "draft" ? "suggested" : "created",
      ts,
    );
  });
  tx();
  return rowToLore(
    db.prepare("SELECT * FROM lore WHERE id = ?").get(id) as LoreRow,
    repos,
    tags,
  );
}

/** Human-authored entry. Defaults to `status: 'active'`. */
export function addLore(db: Database, input: AddLoreInput): Lore {
  return insertLore(db, input, "active");
}

/**
 * Agent-authored entry. Always lands as `status: 'draft'` — hidden from
 * default search until a human runs `lore approve <id>`. This is the
 * tool the MCP server exposes; agents cannot promote their own records.
 */
export function suggestLore(db: Database, input: AddLoreInput): Lore {
  return insertLore(db, input, "draft");
}

export function getLore(db: Database, id: string): Lore | null {
  const row = db.prepare("SELECT * FROM lore WHERE id = ?").get(id) as
    | LoreRow
    | undefined;
  if (!row) return null;
  return rowToLore(row, reposOf(db, id), tagsOf(db, id));
}

/** Promote draft → active. Returns null on unknown id or non-draft status. */
export function approveLore(db: Database, id: string): Lore | null {
  const ts = nowIso();
  const r = db
    .prepare(
      "UPDATE lore SET status = 'active', updated_at = ? WHERE id = ? AND status = 'draft'",
    )
    .run(ts, id);
  if (r.changes === 0) return null;
  db.prepare(
    "INSERT INTO events (lore_id, kind, ts) VALUES (?, 'approved', ?)",
  ).run(id, ts);
  return getLore(db, id);
}

/** Mark deprecated — stays findable only with `includeDeprecated`. */
export function deprecateLore(db: Database, id: string): Lore | null {
  const ts = nowIso();
  const r = db
    .prepare(
      "UPDATE lore SET status = 'deprecated', updated_at = ? WHERE id = ?",
    )
    .run(ts, id);
  if (r.changes === 0) return null;
  db.prepare(
    "INSERT INTO events (lore_id, kind, ts) VALUES (?, 'deprecated', ?)",
  ).run(id, ts);
  return getLore(db, id);
}

/**
 * Mark `oldId` as superseded by `newId`. Old record → status='superseded'
 * + supersededBy=newId. New record is left as-is (typically already active).
 */
export function supersedeLore(
  db: Database,
  oldId: string,
  newId: string,
): Lore | null {
  if (oldId === newId) return null;
  const ts = nowIso();
  const r = db
    .prepare(
      "UPDATE lore SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?",
    )
    .run(newId, ts, oldId);
  if (r.changes === 0) return null;
  db.prepare(
    "INSERT INTO events (lore_id, kind, ts, payload) VALUES (?, 'superseded', ?, ?)",
  ).run(oldId, ts, JSON.stringify({ supersededBy: newId }));
  return getLore(db, oldId);
}

/** Bump `last_verified_at`. Records that the lore still applies as of now. */
export function verifyLore(db: Database, id: string): Lore | null {
  const ts = nowIso();
  const r = db
    .prepare(
      "UPDATE lore SET last_verified_at = ?, updated_at = ? WHERE id = ?",
    )
    .run(ts, ts, id);
  if (r.changes === 0) return null;
  db.prepare(
    "INSERT INTO events (lore_id, kind, ts) VALUES (?, 'verified', ?)",
  ).run(id, ts);
  return getLore(db, id);
}

export function deleteLore(db: Database, id: string): boolean {
  const ts = nowIso();
  const row = db
    .prepare("SELECT rowid FROM lore WHERE id = ?")
    .get(id) as { rowid: number } | undefined;
  if (!row) return false;
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM lore_fts WHERE rowid = ?").run(row.rowid);
    db.prepare("DELETE FROM lore WHERE id = ?").run(id);
    db.prepare(
      "INSERT INTO events (lore_id, kind, ts) VALUES (?, 'deleted', ?)",
    ).run(id, ts);
  });
  tx();
  return true;
}

/**
 * FTS-backed search. Default behaviour (designed for token efficiency
 * and agent trust):
 *
 *   - Only `status='active'` records are returned. Drafts (agent-
 *     suggested but un-approved), deprecated, and superseded records
 *     are hidden unless their respective `include*` flag is set.
 *   - `restricted` records are excluded unless `includeRestricted`.
 *   - Returns `LoreSummary` (no body). Use `get_lore(id)` to fetch the
 *     full body on demand. This is the token-saving contract.
 *   - Stale records (review_after in the past) DO appear but each
 *     result is flagged `stale: true` so the agent can warn the user.
 *
 * Ranking: FTS bm25 when `query` is set; otherwise `updated_at` desc.
 */
export function searchLore(
  db: Database,
  opts: SearchOptions = {},
): LoreSummary[] {
  const limit = Math.min(opts.limit ?? 10, 50);
  const allowedStatuses: LoreStatus[] = ["active"];
  if (opts.includeDrafts) allowedStatuses.push("draft");
  if (opts.includeDeprecated) allowedStatuses.push("deprecated");
  if (opts.includeSuperseded) allowedStatuses.push("superseded");

  const filters: string[] = [];
  const params: Array<string | number> = [];

  const hasFts = !!opts.query && opts.query.trim().length > 0;
  let from: string;
  let select: string;
  if (hasFts) {
    from = `lore l JOIN lore_fts fts ON fts.rowid = l.rowid`;
    select = `l.*, bm25(lore_fts) AS score`;
    filters.push("lore_fts MATCH ?");
    params.push(toFtsQuery(opts.query!.trim()));
  } else {
    from = `lore l`;
    select = `l.*, NULL AS score`;
  }
  filters.push(
    `l.status IN (${allowedStatuses.map(() => "?").join(",")})`,
  );
  params.push(...allowedStatuses);
  if (!opts.includeRestricted) {
    filters.push("l.restricted = 0");
  }
  if (opts.repo) {
    filters.push(`l.id IN (SELECT lore_id FROM lore_repos WHERE repo = ?)`);
    params.push(opts.repo);
  }
  if (opts.tag) {
    filters.push(`l.id IN (SELECT lore_id FROM lore_tags WHERE tag = ?)`);
    params.push(normaliseTag(opts.tag));
  }
  if (opts.since) {
    filters.push("l.updated_at >= ?");
    params.push(opts.since);
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const orderBy = hasFts
    ? "ORDER BY score ASC, l.updated_at DESC"
    : "ORDER BY l.updated_at DESC";
  const sql = `
    SELECT ${select}
    FROM ${from}
    ${where}
    ${orderBy}
    LIMIT ${limit}
  `;
  const rows = db.prepare(sql).all(...params) as Array<
    LoreRow & { score: number | null }
  >;
  return rows.map((row) => {
    const repos = reposOf(db, row.id);
    const tags = tagsOf(db, row.id);
    return rowToSummary(row, repos, tags, row.score ?? undefined);
  });
}

/**
 * Translate a free-text query into an FTS5 MATCH expression.
 * Split on whitespace, drop empties, quote each term — stops users
 * accidentally tripping FTS operators (NEAR, OR, AND, ", :, etc.).
 */
function toFtsQuery(input: string): string {
  const parts = input
    .split(/\s+/)
    .map((p) => p.replace(/"/g, ""))
    .filter(Boolean);
  if (parts.length === 0) return '""';
  return parts.map((p) => `"${p}"`).join(" ");
}

/**
 * Recent lore across all lifecycle states (active + draft + deprecated),
 * freshest first. Used by `lore list` for at-a-glance browse.
 */
export function listRecent(db: Database, limit = 20): LoreSummary[] {
  return searchLore(db, {
    limit,
    includeRestricted: true,
    includeDrafts: true,
    includeDeprecated: true,
  });
}

/** Drafts awaiting human review. Surfaced by `lore review`. */
export function listDrafts(db: Database): LoreSummary[] {
  const rows = db
    .prepare(
      "SELECT *, NULL AS score FROM lore WHERE status = 'draft' ORDER BY created_at DESC",
    )
    .all() as Array<LoreRow & { score: null }>;
  return rows.map((r) =>
    rowToSummary(r, reposOf(db, r.id), tagsOf(db, r.id)),
  );
}

export function listTags(db: Database): string[] {
  return (
    db
      .prepare("SELECT DISTINCT tag FROM lore_tags ORDER BY tag")
      .all() as Array<{ tag: string }>
  ).map((r) => r.tag);
}

export function listRepos(db: Database): string[] {
  return (
    db
      .prepare("SELECT DISTINCT repo FROM lore_repos ORDER BY repo")
      .all() as Array<{ repo: string }>
  ).map((r) => r.repo);
}
