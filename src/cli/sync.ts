/**
 * `lore sync` — Markdown round-trip for PR-reviewable team lore.
 *
 * SQLite stays the canonical source of truth for v0.1. `.lore/<id>.md`
 * is a sync artifact: a frontmatter+body file per record, committable
 * to the repo so a team can review knowledge in pull requests. Import
 * is the inverse: parse the .md files back into the SQLite store.
 *
 * Deliberately uses a tiny YAML-shaped frontmatter parser instead of
 * pulling in a YAML dep. The frontmatter schema is flat — scalars and
 * string arrays — so this stays well-defined. Anything richer (nested
 * mappings, block scalars, anchors) is out of scope.
 */
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { Database } from "better-sqlite3";

import {
  exportLore,
  upsertLoreFromImport,
} from "../core/lore.js";
import type { Lore, LoreStatus, LoreConfidence } from "../db/types.js";

const ALLOWED_STATUS = new Set<LoreStatus>([
  "draft",
  "active",
  "deprecated",
  "superseded",
]);
const ALLOWED_CONFIDENCE = new Set<LoreConfidence>(["low", "medium", "high"]);

// ── Frontmatter parser ────────────────────────────────────────────────

export interface ParsedFile {
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
}

/**
 * Parse a Markdown file with leading YAML-shaped frontmatter. Supports:
 *   - opening / closing `---` fences
 *   - `key: scalar` (string, ISO date, boolean, optionally quoted)
 *   - `key:` followed by `  - item` lines for string arrays
 * Returns null when the file doesn't start with a frontmatter fence.
 */
export function parseFrontmatter(text: string): ParsedFile | null {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return null;
  const fm: Record<string, unknown> = {};
  let i = 1;
  let currentArrayKey: string | null = null;
  let closed = false;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "---") {
      closed = true;
      i++;
      break;
    }
    if (line.trim() === "") continue;
    // List item under the current key.
    if (currentArrayKey && line.startsWith("  - ")) {
      const arr = fm[currentArrayKey] as string[];
      arr.push(unquote(line.slice(4).trim()));
      continue;
    }
    // Otherwise: this is a new key. Reset array context.
    const colonAt = line.indexOf(":");
    if (colonAt < 0) continue;
    const key = line.slice(0, colonAt).trim();
    const rest = line.slice(colonAt + 1).trim();
    if (rest === "") {
      // Block scalar / array marker.
      fm[key] = [];
      currentArrayKey = key;
    } else {
      fm[key] = parseScalar(rest);
      currentArrayKey = null;
    }
  }
  if (!closed) return null;
  const body = lines.slice(i).join("\n").replace(/^\n+/, "");
  return { frontmatter: fm, body };
}

function unquote(s: string): string {
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'")))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function parseScalar(s: string): unknown {
  const v = unquote(s);
  if (v === "true") return true;
  if (v === "false") return false;
  return v;
}

// ── Frontmatter emitter ───────────────────────────────────────────────

/**
 * Serialise a Lore record as `<frontmatter>---\n\n<body>\n`. The
 * frontmatter schema is the inverse of parseFrontmatter so a round
 * trip is lossless for everything we care about.
 *
 * Field ordering is fixed for diff stability: two exports of the same
 * record produce byte-identical .md files.
 */
export function renderLoreMarkdown(lore: Lore): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`id: ${lore.id}`);
  lines.push(`title: ${yamlScalar(lore.title)}`);
  lines.push(`summary: ${yamlScalar(lore.summary)}`);
  lines.push(`status: ${lore.status}`);
  lines.push(`confidence: ${lore.confidence}`);
  lines.push(`restricted: ${lore.restricted}`);
  if (lore.author !== undefined) lines.push(`author: ${yamlScalar(lore.author)}`);
  if (lore.team !== undefined) lines.push(`team: ${yamlScalar(lore.team)}`);
  if (lore.source !== undefined) lines.push(`source: ${lore.source}`);
  if (lore.reviewAfter !== undefined) lines.push(`reviewAfter: ${lore.reviewAfter}`);
  if (lore.supersededBy !== undefined) lines.push(`supersededBy: ${lore.supersededBy}`);
  lines.push(`createdAt: ${lore.createdAt}`);
  lines.push(`updatedAt: ${lore.updatedAt}`);
  if (lore.lastVerifiedAt !== undefined) {
    lines.push(`lastVerifiedAt: ${lore.lastVerifiedAt}`);
  }
  if (lore.repos.length > 0) {
    lines.push("repos:");
    for (const r of lore.repos) lines.push(`  - ${r}`);
  }
  if (lore.tags.length > 0) {
    lines.push("tags:");
    for (const t of lore.tags) lines.push(`  - ${t}`);
  }
  lines.push("---");
  lines.push("");
  lines.push(lore.body);
  lines.push("");
  return lines.join("\n");
}

/**
 * Quote a scalar that would otherwise look like a YAML special form
 * (starts with a special char, contains a colon, etc.). Cheap and
 * conservative — quote anything with a colon or leading non-alnum.
 */
function yamlScalar(v: string): string {
  if (v === "") return '""';
  if (/[:#&*!|>'"%@`]/.test(v) || /^\s|\s$/.test(v) || /\n/.test(v)) {
    return JSON.stringify(v);
  }
  return v;
}

// ── Export ────────────────────────────────────────────────────────────

export interface ExportSyncOptions {
  readonly includeDrafts?: boolean;
  readonly includeDeprecated?: boolean;
  readonly includeSuperseded?: boolean;
  readonly includeRestricted?: boolean;
}

export interface ExportSyncResult {
  readonly written: ReadonlyArray<string>;
  readonly excluded: { restricted: number; drafts: number };
}

/**
 * Write one `<id>.md` per record into `dir`. Filter defaults mirror
 * the JSON export — active, non-restricted only — with the same four
 * opt-ins. The directory is created (mode 0755) if missing.
 *
 * Existing files in the dir are NOT removed: callers that want a
 * deterministic mirror should clear the dir first. This avoids
 * surprising deletions when someone runs `lore sync export` against
 * a working copy.
 */
export function exportToDir(
  db: Database,
  dir: string,
  opts: ExportSyncOptions = {},
): ExportSyncResult {
  // Always count restricted / drafts that we DIDN'T export — useful
  // signal for the CLI summary so a user knows something was held back.
  const fullSet = exportLore(db, {
    includeDrafts: true,
    includeDeprecated: opts.includeDeprecated,
    includeSuperseded: opts.includeSuperseded,
    includeRestricted: true,
  });
  const filtered = fullSet.filter((r) => {
    if (r.restricted && !opts.includeRestricted) return false;
    if (r.status === "draft" && !opts.includeDrafts) return false;
    return true;
  });
  const excludedRestricted = fullSet.filter(
    (r) => r.restricted && !opts.includeRestricted,
  ).length;
  const excludedDrafts = fullSet.filter(
    (r) => r.status === "draft" && !opts.includeDrafts,
  ).length;
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const written: string[] = [];
  for (const lore of filtered) {
    const path = join(dir, `${lore.id}.md`);
    writeFileSync(path, renderLoreMarkdown(lore), { encoding: "utf8" });
    try {
      chmodSync(path, 0o644);
    } catch {
      // best-effort
    }
    written.push(path);
  }
  return {
    written,
    excluded: { restricted: excludedRestricted, drafts: excludedDrafts },
  };
}

// ── Import ────────────────────────────────────────────────────────────

export interface ImportSyncOptions {
  /**
   * If true, import even restricted records from the .lore/ directory.
   * Off by default — committed restricted records are a red flag, but
   * an opt-in matters for teams that have a private repo and treat the
   * git history as the security boundary.
   */
  readonly includeRestricted?: boolean;
}

export interface ImportSyncResult {
  readonly created: number;
  readonly updated: number;
  readonly skipped: ReadonlyArray<{ file: string; reason: string }>;
}

/**
 * Read every `*.md` file in `dir` and upsert each one. Files without
 * frontmatter, or with frontmatter that's missing required fields
 * (id, title, summary, status), are skipped with a reason rather
 * than crashing the import.
 *
 * Per the PR-is-the-review-gate decision, imports respect whatever
 * status the file declares. Restricted records are excluded by
 * default (opt-in via includeRestricted).
 */
export function importFromDir(
  db: Database,
  dir: string,
  opts: ImportSyncOptions = {},
): ImportSyncResult {
  let created = 0;
  let updated = 0;
  const skipped: Array<{ file: string; reason: string }> = [];
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch (err) {
    throw new Error(
      `lore sync import: cannot read directory ${dir} — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  for (const file of entries) {
    const path = join(dir, file);
    const text = readFileSync(path, "utf8");
    const parsed = parseFrontmatter(text);
    if (!parsed) {
      skipped.push({ file, reason: "no frontmatter" });
      continue;
    }
    const fm = parsed.frontmatter;
    const id = fm["id"];
    const title = fm["title"];
    const summary = fm["summary"];
    const status = fm["status"];
    if (typeof id !== "string" || id.length === 0) {
      skipped.push({ file, reason: "missing or invalid id" });
      continue;
    }
    if (typeof title !== "string" || title.length === 0) {
      skipped.push({ file, reason: "missing or invalid title" });
      continue;
    }
    if (typeof summary !== "string" || summary.length === 0) {
      skipped.push({ file, reason: "missing or invalid summary" });
      continue;
    }
    if (typeof status !== "string" || !ALLOWED_STATUS.has(status as LoreStatus)) {
      skipped.push({
        file,
        reason: `missing or invalid status (got ${JSON.stringify(status)})`,
      });
      continue;
    }
    const restrictedRaw = fm["restricted"];
    const restricted = restrictedRaw === true;
    if (restricted && !opts.includeRestricted) {
      skipped.push({ file, reason: "restricted (use --include-restricted to import)" });
      continue;
    }
    const confidenceRaw = fm["confidence"];
    const confidence =
      typeof confidenceRaw === "string" &&
      ALLOWED_CONFIDENCE.has(confidenceRaw as LoreConfidence)
        ? (confidenceRaw as LoreConfidence)
        : undefined;
    const repos = fm["repos"];
    const tags = fm["tags"];
    const result = upsertLoreFromImport(db, {
      id,
      title,
      summary,
      body: parsed.body.trimEnd(),
      status: status as LoreStatus,
      author: typeof fm["author"] === "string" ? (fm["author"] as string) : undefined,
      team: typeof fm["team"] === "string" ? (fm["team"] as string) : undefined,
      source: typeof fm["source"] === "string" ? (fm["source"] as string) : undefined,
      reviewAfter:
        typeof fm["reviewAfter"] === "string"
          ? (fm["reviewAfter"] as string)
          : undefined,
      confidence,
      repos: Array.isArray(repos) ? (repos as string[]) : undefined,
      tags: Array.isArray(tags) ? (tags as string[]) : undefined,
      restricted,
      supersededBy:
        typeof fm["supersededBy"] === "string"
          ? (fm["supersededBy"] as string)
          : undefined,
      createdAt:
        typeof fm["createdAt"] === "string"
          ? (fm["createdAt"] as string)
          : undefined,
      updatedAt:
        typeof fm["updatedAt"] === "string"
          ? (fm["updatedAt"] as string)
          : undefined,
      lastVerifiedAt:
        typeof fm["lastVerifiedAt"] === "string"
          ? (fm["lastVerifiedAt"] as string)
          : undefined,
    });
    if (result.created) created++;
    else updated++;
  }
  return { created, updated, skipped };
}
