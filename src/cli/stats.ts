/**
 * `loreguard stats` — local read-tracking view.
 *
 * Answers "is loreguard earning its keep?" without sending anything
 * off-box. Reads aggregate-only against the existing `events` table
 * (no new schema): 'read' events are emitted by core/lore.ts on each
 * search hit and each `getLore` fetch, gated by env vars
 * (LOREGUARD_NO_TELEMETRY / LOREGUARD_AUDIT_OFF).
 *
 * Three views the CLI renders:
 *
 *   - topCitedRecords — what's pulling weight in the recent window
 *   - retireCandidates — active records with zero reads in a longer
 *     window (the dead-weight signal)
 *   - recentActivity — event-kind histogram over a window
 */
import type { Database } from "better-sqlite3";

export interface TopCitedRecord {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly readCount: number;
}

export interface RetireCandidate {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly lastReadAt: string | null;
  readonly confidence: string;
  readonly hasSource: boolean;
  readonly updatedAt: string;
}

export interface RecentActivity {
  readonly suggested: number;
  readonly approved: number;
  readonly rejected: number;
  readonly deprecated: number;
  readonly superseded: number;
  readonly updated: number;
  readonly reads: number;
  readonly imports: number;
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString();
}

/**
 * Most-cited records in the window. `readCount` is the number of
 * 'read' events for that lore_id with `ts >= sinceDays-ago`. Default
 * window 90 days, default limit 10.
 *
 * INNER JOINs against `lore` so a record that was hard-deleted (its
 * events stay, the row is gone) doesn't show up as a phantom hit.
 */
export function topCitedRecords(
  db: Database,
  opts: { sinceDays?: number; limit?: number } = {},
): TopCitedRecord[] {
  const since = isoDaysAgo(opts.sinceDays ?? 90);
  const limit = opts.limit ?? 10;
  const rows = db
    .prepare(
      `SELECT l.id AS id, l.title AS title, l.status AS status,
              COUNT(e.rowid) AS readCount
       FROM events e
       INNER JOIN lore l ON l.id = e.lore_id
       WHERE e.kind = 'read' AND e.ts >= ?
       GROUP BY l.id
       ORDER BY readCount DESC, l.updated_at DESC
       LIMIT ?`,
    )
    .all(since, limit) as Array<{
    id: string;
    title: string;
    status: string;
    readCount: number;
  }>;
  return rows;
}

/**
 * Active records with no reads in the past `quietForDays` days
 * (default 180). Sort key prioritises records the team is least
 * attached to: no-source first, then ascending confidence
 * (low → medium → high), then oldest updated_at.
 */
export function retireCandidates(
  db: Database,
  opts: { quietForDays?: number } = {},
): RetireCandidate[] {
  const cutoff = isoDaysAgo(opts.quietForDays ?? 180);
  const rows = db
    .prepare(
      `WITH last_reads AS (
         SELECT lore_id, MAX(ts) AS last_read_at
         FROM events WHERE kind = 'read'
         GROUP BY lore_id
       )
       SELECT l.id AS id, l.title AS title, l.status AS status,
              lr.last_read_at AS lastReadAt,
              l.confidence AS confidence,
              CASE WHEN l.source IS NULL OR l.source = '' THEN 0 ELSE 1 END AS hasSource,
              l.updated_at AS updatedAt
       FROM lore l
       LEFT JOIN last_reads lr ON lr.lore_id = l.id
       WHERE l.status = 'active'
         AND (lr.last_read_at IS NULL OR lr.last_read_at < ?)
       ORDER BY hasSource ASC,
                CASE l.confidence
                  WHEN 'low' THEN 0
                  WHEN 'medium' THEN 1
                  WHEN 'high' THEN 2
                  ELSE 1
                END ASC,
                l.updated_at ASC`,
    )
    .all(cutoff) as Array<{
    id: string;
    title: string;
    status: string;
    lastReadAt: string | null;
    confidence: string;
    hasSource: 0 | 1;
    updatedAt: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    lastReadAt: r.lastReadAt,
    confidence: r.confidence,
    hasSource: r.hasSource === 1,
    updatedAt: r.updatedAt,
  }));
}

const KNOWN_KINDS = new Set([
  "suggested",
  "approved",
  "rejected",
  "deprecated",
  "superseded",
  "updated",
  "read",
  "imported",
]);

export function recentActivity(
  db: Database,
  opts: { days?: number } = {},
): RecentActivity {
  const since = isoDaysAgo(opts.days ?? 30);
  const rows = db
    .prepare(
      "SELECT kind, COUNT(*) AS n FROM events WHERE ts >= ? GROUP BY kind",
    )
    .all(since) as Array<{ kind: string; n: number }>;
  const totals: Record<string, number> = {};
  for (const r of rows) {
    if (KNOWN_KINDS.has(r.kind)) totals[r.kind] = r.n;
  }
  return {
    suggested: totals["suggested"] ?? 0,
    approved: totals["approved"] ?? 0,
    rejected: totals["rejected"] ?? 0,
    deprecated: totals["deprecated"] ?? 0,
    superseded: totals["superseded"] ?? 0,
    updated: totals["updated"] ?? 0,
    reads: totals["read"] ?? 0,
    imports: totals["imported"] ?? 0,
  };
}

/** Render the default three-section human report. */
export function renderStatsReport(
  top: TopCitedRecord[],
  retire: RetireCandidate[],
  activity: RecentActivity,
): string {
  const lines: string[] = [];
  lines.push("Top-cited records (last 90 days):");
  if (top.length === 0) {
    lines.push("  (no reads recorded yet — run a search or two)");
  } else {
    for (const r of top.slice(0, 10)) {
      lines.push(`  ${r.readCount.toString().padStart(4)}× ${r.id}  ${r.title}`);
    }
  }
  lines.push("");
  lines.push(
    `Retirement candidates (active + no reads in 180 days): ${retire.length}`,
  );
  for (const r of retire.slice(0, 5)) {
    const lastSeen = r.lastReadAt ? `last read ${r.lastReadAt.slice(0, 10)}` : "never read";
    const src = r.hasSource ? "sourced" : "no source";
    lines.push(
      `  ${r.id}  ${r.title}  [${r.confidence}, ${src}, ${lastSeen}]`,
    );
  }
  if (retire.length > 5) {
    lines.push(`  ... and ${retire.length - 5} more (run with --retire to see all)`);
  }
  lines.push("");
  lines.push("Recent activity (last 30 days):");
  lines.push(
    `  suggested ${activity.suggested}  approved ${activity.approved}  rejected ${activity.rejected}  deprecated ${activity.deprecated}`,
  );
  lines.push(
    `  superseded ${activity.superseded}  updated ${activity.updated}  reads ${activity.reads}  imports ${activity.imports}`,
  );
  return lines.join("\n");
}
