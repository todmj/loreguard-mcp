import type { Database } from "better-sqlite3";

import type {
  AddLoreInput,
  Lore,
  LoreConfidence,
  LoreRow,
  LoreStatus,
  LoreSummary,
  SearchOptions,
  UpdateLoreInput,
} from "../db/types.js";
import { newLoreId } from "./ids.js";

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
  const t = Date.parse(reviewAfter);
  if (Number.isNaN(t)) return false;
  return t < Date.now();
}

/**
 * Validate ISO-8601 date strings at write boundaries. Catches the
 * "new Date('nonsense').getTime() === NaN" footgun that previously
 * disabled staleness silently.
 */
function assertIsoDate(value: string | undefined, field: string): void {
  if (value === undefined) return;
  const t = Date.parse(value);
  if (Number.isNaN(t)) {
    throw new Error(`${field}: '${value}' is not a valid ISO-8601 date`);
  }
}

/**
 * `source` must be a real http(s) URL. The README is explicit about
 * this — sources are PR / ADR / incident permalinks, not free-text
 * shorthand. Keeps the trust signal honest (a real URL can be checked).
 * An empty string is treated as "clear the source" (used by updateLore).
 */
function assertHttpUrl(value: string | undefined, field: string): void {
  if (value === undefined || value === "") return;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${field}: '${value}' is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `${field}: '${value}' must be an http(s) URL (got ${parsed.protocol})`,
    );
  }
}

/**
 * R20 — when verifyLore runs on a record whose review_after has lapsed,
 * push the date this many days forward so the record is no longer
 * flagged stale. Callers can pass a custom date to override.
 */
const VERIFY_DEFAULT_FORWARD_DAYS = 90;

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
 * Confidence invariants (R2 review):
 *   - A record without a `source` can never be `high` confidence. If a
 *     caller asks for `high` without a source, clamp down to `medium`.
 *     This stops well-meaning humans (and rubber-stamping reviewers)
 *     from creating un-anchored "authoritative" rules.
 *   - When status=draft (suggestLore path) the caller's max claim is
 *     `medium`. Only a human, via `addLore` or `approveLore`-then-update,
 *     can stamp `high`.
 */
export function clampConfidence(
  requested: LoreConfidence | undefined,
  hasSource: boolean,
  status: LoreStatus,
): LoreConfidence {
  let c: LoreConfidence = requested ?? "medium";
  if (status === "draft" && c === "high") c = "medium";
  if (c === "high" && !hasSource) c = "medium";
  return c;
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
  const confidence = clampConfidence(input.confidence, !!input.source, status);
  assertIsoDate(input.reviewAfter, "reviewAfter");
  assertHttpUrl(input.source, "source");
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
 *
 * Validates: oldId exists, newId exists, oldId !== newId, and newId
 * itself is not a tombstone (deprecated / superseded). Returns null
 * on any failure rather than throwing — the CLI surfaces a single
 * explanatory message rather than an unhandled error.
 */
export function supersedeLore(
  db: Database,
  oldId: string,
  newId: string,
): Lore | null {
  if (oldId === newId) return null;
  const replacement = db
    .prepare("SELECT id, status FROM lore WHERE id = ?")
    .get(newId) as { id: string; status: LoreStatus } | undefined;
  if (!replacement) return null;
  if (replacement.status === "deprecated" || replacement.status === "superseded") {
    return null;
  }
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

/**
 * Bump `last_verified_at` AND, if `review_after` has lapsed, push it
 * VERIFY_DEFAULT_FORWARD_DAYS days into the future so the record clears
 * the `stale: true` flag. Callers can override by passing an explicit
 * `nextReviewAfter`. Pass `null` to leave `review_after` untouched even
 * if it's lapsed (rare, but useful for "yes I checked, the warning is
 * still right" cases).
 */
export function verifyLore(
  db: Database,
  id: string,
  nextReviewAfter?: string | null,
): Lore | null {
  const current = db
    .prepare(
      "SELECT review_after FROM lore WHERE id = ?",
    )
    .get(id) as { review_after: string | null } | undefined;
  if (!current) return null;

  const ts = nowIso();
  let newReview: string | null = current.review_after;
  if (nextReviewAfter === null) {
    // Explicit "leave alone" — keep whatever's there.
    newReview = current.review_after;
  } else if (typeof nextReviewAfter === "string") {
    assertIsoDate(nextReviewAfter, "nextReviewAfter");
    newReview = nextReviewAfter;
  } else if (isStale(current.review_after)) {
    // Default: lapsed → forward N days. Fresh review_after is left alone.
    const forward = new Date(Date.now() + VERIFY_DEFAULT_FORWARD_DAYS * 86_400_000);
    newReview = forward.toISOString();
  }

  const r = db
    .prepare(
      "UPDATE lore SET last_verified_at = ?, review_after = ?, updated_at = ? WHERE id = ?",
    )
    .run(ts, newReview, ts, id);
  if (r.changes === 0) return null;
  db.prepare(
    "INSERT INTO events (lore_id, kind, ts, payload) VALUES (?, 'verified', ?, ?)",
  ).run(id, ts, JSON.stringify({ reviewAfter: newReview }));
  return getLore(db, id);
}

/**
 * Partial update — title / summary / body / metadata. Use for fixing
 * an agent's draft text before approval, or correcting an active
 * record. Status transitions go through approve/deprecate/supersede,
 * not this. Tags and repos when present REPLACE the existing set.
 *
 * Confidence invariants still apply: clampConfidence enforces the
 * "agent draft can't claim high" / "sourceless can't be high" rules
 * even via update (status comes from the current row).
 */
export function updateLore(
  db: Database,
  id: string,
  input: UpdateLoreInput,
): Lore | null {
  const current = db.prepare("SELECT * FROM lore WHERE id = ?").get(id) as
    | LoreRow
    | undefined;
  if (!current) return null;

  assertIsoDate(
    input.reviewAfter === null ? undefined : input.reviewAfter,
    "reviewAfter",
  );
  assertHttpUrl(input.source, "source");

  // Resolve final values, falling back to current row when not provided.
  const title = input.title ?? current.title;
  const summary = input.summary ?? current.summary;
  const body = input.body ?? current.body;
  const author = input.author !== undefined ? input.author : current.author;
  const team = input.team !== undefined ? input.team : current.team;
  // Empty string is the explicit "clear the source" signal (since the
  // `source: undefined` case means "no change"). NULL in storage; the
  // confidence re-clamp will catch any high→medium fallout.
  const source =
    input.source === ""
      ? null
      : input.source !== undefined
        ? input.source
        : current.source;
  const reviewAfter =
    input.reviewAfter === null
      ? null
      : input.reviewAfter !== undefined
        ? input.reviewAfter
        : current.review_after;
  const restricted =
    input.restricted !== undefined ? (input.restricted ? 1 : 0) : current.restricted;
  // Confidence: caller's claim, but re-clamped given (possibly new) source + current status.
  const confidence = clampConfidence(
    input.confidence ?? current.confidence,
    !!source,
    current.status,
  );

  const ts = nowIso();
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE lore SET
        title = ?, summary = ?, body = ?,
        author = ?, team = ?, source = ?,
        review_after = ?, confidence = ?, restricted = ?,
        updated_at = ?
       WHERE id = ?`,
    ).run(
      title,
      summary,
      body,
      author,
      team,
      source,
      reviewAfter,
      confidence,
      restricted,
      ts,
      id,
    );
    // If any of title/summary/body changed, reindex FTS for this row.
    if (
      input.title !== undefined ||
      input.summary !== undefined ||
      input.body !== undefined
    ) {
      // Need the rowid for FTS — fetch via a join since `lore.id` is a
      // separate string id from the implicit rowid.
      const rowid = (
        db.prepare("SELECT rowid FROM lore WHERE id = ?").get(id) as {
          rowid: number;
        }
      ).rowid;
      db.prepare("DELETE FROM lore_fts WHERE rowid = ?").run(rowid);
      db.prepare(
        "INSERT INTO lore_fts(rowid, title, summary, body) VALUES (?, ?, ?, ?)",
      ).run(rowid, title, summary, body);
    }
    if (input.repos !== undefined) {
      const repos = Array.from(
        new Set(input.repos.map(normaliseRepo).filter(Boolean)),
      ).sort();
      db.prepare("DELETE FROM lore_repos WHERE lore_id = ?").run(id);
      const ins = db.prepare(
        "INSERT INTO lore_repos (lore_id, repo) VALUES (?, ?)",
      );
      for (const r of repos) ins.run(id, r);
    }
    if (input.tags !== undefined) {
      const tags = Array.from(
        new Set(input.tags.map(normaliseTag).filter(Boolean)),
      ).sort();
      db.prepare("DELETE FROM lore_tags WHERE lore_id = ?").run(id);
      const ins = db.prepare(
        "INSERT INTO lore_tags (lore_id, tag) VALUES (?, ?)",
      );
      for (const t of tags) ins.run(id, t);
    }
    db.prepare(
      "INSERT INTO events (lore_id, kind, ts) VALUES (?, 'updated', ?)",
    ).run(id, ts);
  });
  tx();
  return getLore(db, id);
}

/**
 * Reject a draft. Hard-deletes the row + cascades repos/tags, but emits
 * a `rejected` event (not `deleted`) so the audit chain shows the human
 * triage decision distinct from a manual `lore delete`. Refuses to act
 * on non-drafts — promoted records get `deprecateLore` / `supersedeLore`
 * instead.
 *
 * Returns true on success, false if the id doesn't exist or isn't a draft.
 */
export function rejectLore(db: Database, id: string): boolean {
  const ts = nowIso();
  const row = db
    .prepare("SELECT rowid, status FROM lore WHERE id = ?")
    .get(id) as { rowid: number; status: LoreStatus } | undefined;
  if (!row) return false;
  if (row.status !== "draft") return false;
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM lore_fts WHERE rowid = ?").run(row.rowid);
    db.prepare("DELETE FROM lore WHERE id = ?").run(id);
    db.prepare(
      "INSERT INTO events (lore_id, kind, ts) VALUES (?, 'rejected', ?)",
    ).run(id, ts);
  });
  tx();
  return true;
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
  if (opts.updatedAfter) {
    filters.push("l.updated_at >= ?");
    params.push(opts.updatedAfter);
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
