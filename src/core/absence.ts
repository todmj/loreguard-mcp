/**
 * Verified-absence markers.
 *
 * Records "we checked here, nothing relevant exists, this is intentional
 * for now". When `search_lore` returns zero hits AND a matching active
 * marker exists, the response is decorated with the marker so the next
 * agent knows it's an acknowledged gap rather than an oversight. Markers
 * expire (default 30 days) so stale "we checked" claims age out
 * automatically instead of becoming permanent dead-end annotations.
 *
 * Distinct from drafts. Drafts gate on human review; absence markers are
 * low-stakes ("we looked, nothing here") and self-expiring, so they have
 * no approval surface. They are recorded explicitly — never auto-emitted
 * on every zero-hit search, since that would surface every random one-off
 * query as a marker.
 */
import type { Database } from "better-sqlite3";

import { newLoreId } from "./ids.js";

export interface AbsenceMarker {
  readonly id: string;
  readonly query: string;
  readonly repo: string | null;
  readonly reason: string;
  readonly recordedAt: string;
  readonly expiresAt: string;
  readonly recordedBy: string;
}

export interface RecordAbsenceInput {
  readonly query: string;
  readonly reason: string;
  readonly repo?: string;
  readonly recordedBy: string;
  /** Default 30. Clamped [1, 365] by the CLI/MCP layer; core trusts the caller. */
  readonly expiresInDays?: number;
}

/**
 * Normalise a query for marker matching. Order-independent (sorted),
 * case-insensitive, whitespace-collapsed. Not synonym-aware — that's
 * fine; the agent re-records if its phrasing differs enough to matter,
 * and over-aggressive matching would silently swallow real searches.
 *
 *   "Retry policy payments-svc" → "payments-svc policy retry"
 *   "payments-svc retry policy"  → "payments-svc policy retry"  (same key)
 *   "backoff strategy"           → "backoff strategy"            (distinct)
 */
export function normaliseAbsenceQuery(q: string): string {
  return q
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .sort()
    .join(" ");
}

function nowIso(): string {
  return new Date().toISOString();
}

function isoNDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 86400_000).toISOString();
}

function rowToMarker(row: {
  id: string;
  query: string;
  repo: string | null;
  reason: string;
  recorded_at: string;
  expires_at: string;
  recorded_by: string;
}): AbsenceMarker {
  return {
    id: row.id,
    query: row.query,
    repo: row.repo,
    reason: row.reason,
    recordedAt: row.recorded_at,
    expiresAt: row.expires_at,
    recordedBy: row.recorded_by,
  };
}

export function recordAbsence(
  db: Database,
  input: RecordAbsenceInput,
): { id: string; expiresAt: string } {
  if (input.query.trim().length === 0) {
    throw new Error("recordAbsence: query must be non-empty");
  }
  if (input.reason.trim().length === 0) {
    throw new Error("recordAbsence: reason must be non-empty");
  }
  const id = newLoreId();
  const recordedAt = nowIso();
  const expiresAt = isoNDaysFromNow(input.expiresInDays ?? 30);
  db.prepare(
    `INSERT INTO absence_markers (id, query, repo, reason, recorded_at, expires_at, recorded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    normaliseAbsenceQuery(input.query),
    input.repo ?? null,
    input.reason.trim(),
    recordedAt,
    expiresAt,
    input.recordedBy,
  );
  return { id, expiresAt };
}

/**
 * Return the most-recent active (non-expired) marker matching the
 * normalised query. When `repo` is given, prefer markers scoped to that
 * repo; fall back to global markers (repo IS NULL) if no repo-specific
 * marker exists. Returns null when nothing matches.
 */
export function findActiveAbsence(
  db: Database,
  opts: { query: string; repo?: string },
): AbsenceMarker | null {
  const key = normaliseAbsenceQuery(opts.query);
  if (key.length === 0) return null;
  const now = nowIso();
  if (opts.repo) {
    const specific = db
      .prepare(
        `SELECT * FROM absence_markers
         WHERE query = ? AND repo = ? AND expires_at > ?
         ORDER BY recorded_at DESC LIMIT 1`,
      )
      .get(key, opts.repo, now) as Parameters<typeof rowToMarker>[0] | undefined;
    if (specific) return rowToMarker(specific);
  }
  const global = db
    .prepare(
      `SELECT * FROM absence_markers
       WHERE query = ? AND repo IS NULL AND expires_at > ?
       ORDER BY recorded_at DESC LIMIT 1`,
    )
    .get(key, now) as Parameters<typeof rowToMarker>[0] | undefined;
  return global ? rowToMarker(global) : null;
}

export function listAbsences(
  db: Database,
  opts: { includeExpired?: boolean } = {},
): AbsenceMarker[] {
  const sql = opts.includeExpired
    ? "SELECT * FROM absence_markers ORDER BY recorded_at DESC"
    : "SELECT * FROM absence_markers WHERE expires_at > ? ORDER BY recorded_at DESC";
  const rows = (opts.includeExpired
    ? db.prepare(sql).all()
    : db.prepare(sql).all(nowIso())) as Array<Parameters<typeof rowToMarker>[0]>;
  return rows.map(rowToMarker);
}
