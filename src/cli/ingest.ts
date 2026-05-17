/**
 * `loreguard ingest-md <glob>` — bulk-import drafts from Markdown.
 *
 * Solves the cold-start adoption problem: most teams already have rich
 * context in CLAUDE.md, ADR files, MIGRATION notes, and incident
 * postmortems. Rather than retyping that into `loreguard add` one
 * record at a time, this walks the given glob, splits each file into
 * candidates, and emits one DRAFT `suggestLore` per candidate. The
 * reviewer still gates every draft via `loreguard review` — trust
 * model unchanged.
 *
 * Splitting is deliberately simple — H3 subsections OR top-level
 * bullets (`- ` / `* `), whichever appears first in the file. Anything
 * richer (frontmatter, tables, nested formatting) is out of scope;
 * the user can hand-edit drafts during review.
 */

export interface IngestCandidate {
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  /** Line number of the candidate's anchor (heading or bullet) in the source file, 1-indexed. */
  readonly sourceLine: number;
}

/** Items shorter than this are skipped as likely noise ("TBD", "—", "?"). */
const MIN_CANDIDATE_BODY_CHARS = 30;
/** Title fragment cap when deriving from bullets without an obvious sentence break. */
const BULLET_TITLE_MAX = 80;
/** Summary cap to keep individual records reviewable in the existing CLI. */
const SUMMARY_MAX = 800;

/**
 * Filenames that smell like intent / status / spec docs rather than
 * durable team knowledge. Real-world dogfood (a 583-record import on
 * a typical backend repo) showed ~75% of the noise came from these
 * file shapes — status trackers and roadmaps that decay fast and
 * pollute FTS with terms that have nothing to do with lore.
 *
 * Match is case-insensitive substring on the file's basename (sans
 * extension). The user can override with `--include-intent-files`
 * when they know what they're doing.
 */
export const INTENT_FILENAME_PATTERNS: ReadonlyArray<string> = [
  "plan",
  "roadmap",
  "progress",
  "todo",
  "backlog",
  "spec",
  "usability",
  "status",
  "execution",
];

/**
 * Title pattern: contains a `YYYY-MM` or `YYYY-MM-DD` date stamp
 * anywhere (e.g. `(2026-03-24)`, `(In Progress — 2026-03-21)`,
 * `Q1 2026-03 review`). Strong signal that the heading is a
 * dated status update rather than a durable rule.
 */
const DATE_STAMPED_TITLE_RE = /(?:19|20)\d{2}[-/](?:0?[1-9]|1[0-2])(?:[-/](?:0?[1-9]|[12]\d|3[01]))?/;

/**
 * Title pattern: starts with a strikethrough markdown chunk
 * (`~~something~~ → FIXED`). Common ChangeLog / audit-results
 * shape — the strikethrough means the item was resolved and the
 * heading is a historical changelog entry, not durable lore.
 */
const STRIKETHROUGH_TITLE_RE = /~~[^~]+~~/;

/**
 * Title pattern: numbered phase / milestone / stage. Catches
 * roadmap-style headings buried inside otherwise-allowed files
 * (e.g. `Phase 1 — Make Existing Features Work`, `Milestone 2`).
 */
const PHASE_TITLE_RE = /^\s*(?:phase|milestone|stage|sprint)\s+\d+\b/i;

/**
 * Title pattern: numbered TOC heading (`5.1`, `5.2.3 ...`). Common
 * in auto-generated architecture indexes; the section may contain
 * real content but the title alone gives the agent no signal.
 */
const NUMBERED_TOC_TITLE_RE = /^\s*\d+\.\d+(?:\.\d+)?\s/;

/**
 * Imperative / rule markers — text that signals "this is a thing you
 * MUST/SHOULD do." Real lore tends to contain at least one.
 * Word-boundary, case-insensitive match.
 */
const IMPERATIVE_MARKERS: ReadonlyArray<string> = [
  "must",
  "must not",
  "should",
  "should not",
  "always",
  "never",
  "do not",
  "don't",
  "prefer",
  "avoid",
  "required",
];

/**
 * Durable-fact markers — descriptive sentences that state how the
 * system actually works (not what it might do or used to do). Short
 * lore like "Customer IDs are tenant-scoped" can pass on these even
 * without an imperative.
 */
const FACT_MARKERS: ReadonlyArray<string> = [
  "is not",
  "are not",
  "does not",
  "do not",
  "requires",
  "require ",
  "rejects",
  "uses",
  "use only",
  "stores",
  "depends on",
  "only ",
  "cannot",
  "scoped to",
  "contain",
  "contains",
];

/**
 * Future-tense / planning markers — text that signals intent rather
 * than fact. Reduces the score; doesn't hard-reject (planning files
 * are caught earlier by the filename deny-list — these markers catch
 * stray planning paragraphs inside otherwise-good docs).
 */
const FUTURE_TENSE_MARKERS: ReadonlyArray<string> = [
  "will ",
  "plan to",
  "planning to",
  "planned:",
  "target:",
  "todo",
  "tbd",
  "wip",
  "coming soon",
  "intend to",
  "goal:",
  "roadmap:",
  "next quarter",
  "next sprint",
];

export interface CandidateScore {
  readonly score: number;
  readonly pass: boolean;
  /** Human-readable reasons for the score; used in --dry-run summary. */
  readonly reasons: ReadonlyArray<string>;
}

/**
 * Score one parsed candidate. Conservative — requires at least one
 * positive signal (imperative or fact marker) to pass, so chunks
 * with no markers — TOC labels, descriptive section indexes,
 * auto-generated architecture tables — fail even when the body is
 * long. Short factual lore ("Customer IDs are tenant-scoped") still
 * passes on its fact marker.
 *
 * Scoring:
 *   +1 per imperative marker (capped at +2)
 *   +1 per fact marker (capped at +2)
 *   -1 per future-tense marker (capped at -2)
 *
 * Hard rejects (bypass scoring; the heuristic can't redeem them):
 *   - title === summary === body  (collapsed single-line bullet)
 *   - title contains a date stamp like `(2026-03-24)` (status heading)
 *   - title contains a strikethrough chunk (changelog entry, e.g.
 *     `~~CanonicalPublisher field cherry-picking~~ → FIXED`)
 *   - title is `Phase N` / `Milestone N` / etc. (roadmap-within-doc)
 *   - title is a numbered-TOC heading like `5.1 Common Domain`
 *
 * Pass threshold: score >= 1. A record with no positive markers
 * fails regardless of body length — the body might be substantive,
 * but a record the agent retrieves needs SOMETHING the title or
 * body explicitly signals as durable rule / fact. Pure descriptive
 * sections are better answered by reading the code (see
 * docs/PRINCIPLES.md: "lore is for what the agent can't derive").
 */
export function scoreCandidate(c: IngestCandidate): CandidateScore {
  // Hard rejects first.
  if (c.title === c.summary && c.summary === c.body) {
    return {
      score: -99,
      pass: false,
      reasons: ["title===summary===body (collapsed single-line bullet)"],
    };
  }
  if (DATE_STAMPED_TITLE_RE.test(c.title)) {
    return {
      score: -99,
      pass: false,
      reasons: ["date-stamped title (status heading)"],
    };
  }
  if (STRIKETHROUGH_TITLE_RE.test(c.title)) {
    return {
      score: -99,
      pass: false,
      reasons: ["strikethrough title (changelog / resolved entry)"],
    };
  }
  if (PHASE_TITLE_RE.test(c.title)) {
    return {
      score: -99,
      pass: false,
      reasons: ["phase / milestone heading (roadmap-within-doc)"],
    };
  }
  if (NUMBERED_TOC_TITLE_RE.test(c.title)) {
    return {
      score: -99,
      pass: false,
      reasons: ["numbered-TOC heading (5.1 / 5.2.3 / ...)"],
    };
  }

  const reasons: string[] = [];
  let score = 0;
  const titleAndBody = (c.title + "\n" + c.body).toLowerCase();
  const imperativeHits = countMarkers(titleAndBody, IMPERATIVE_MARKERS);
  if (imperativeHits > 0) {
    const add = Math.min(imperativeHits, 2);
    score += add;
    reasons.push(`+${add} imperative marker(s)`);
  }
  const factHits = countMarkers(titleAndBody, FACT_MARKERS);
  if (factHits > 0) {
    const add = Math.min(factHits, 2);
    score += add;
    reasons.push(`+${add} fact marker(s)`);
  }
  const futureHits = countMarkers(titleAndBody, FUTURE_TENSE_MARKERS);
  if (futureHits > 0) {
    const sub = Math.min(futureHits, 2);
    score -= sub;
    reasons.push(`-${sub} future-tense / planning marker(s)`);
  }
  if (score < 1) {
    reasons.push("no positive markers (rule / fact)");
  }
  return { score, pass: score >= 1, reasons };
}

function countMarkers(text: string, markers: ReadonlyArray<string>): number {
  let n = 0;
  for (const m of markers) {
    const idx = text.indexOf(m);
    if (idx === -1) continue;
    // Word-boundary check, but only on the edges of the marker that
    // ARE alphanumeric. If the marker ends with a space (e.g.
    // "require ", "do not ", "use only", "only "), the trailing space
    // IS the boundary — checking the char AFTER the space is wrong
    // (it incorrectly rejects "require an X-User-Id" because "a" is
    // alphanumeric). Same logic mirrored for the start of the marker.
    const firstChar = m[0]!;
    const lastChar = m[m.length - 1]!;
    if (/[a-zA-Z0-9]/.test(firstChar)) {
      const before = idx === 0 ? "" : text[idx - 1]!;
      if (/[a-zA-Z0-9]/.test(before)) continue;
    }
    if (/[a-zA-Z0-9]/.test(lastChar)) {
      const after = text[idx + m.length] ?? "";
      if (/[a-zA-Z0-9]/.test(after)) continue;
    }
    n++;
  }
  return n;
}

/**
 * Does this filename match the intent/status/spec deny-list?
 *
 *   intentFilenameDenied("build_progress.md")  → "progress"
 *   intentFilenameDenied("ADR-014.md")         → null
 *
 * Returns the first matched pattern (for the --dry-run summary) or
 * null when the file is allowed.
 */
export function intentFilenameDenied(filename: string): string | null {
  const base = filename.toLowerCase().replace(/\.md$/i, "");
  for (const pat of INTENT_FILENAME_PATTERNS) {
    if (base.includes(pat)) return pat;
  }
  return null;
}

interface RawSection {
  startLine: number;
  /** Heading level (h1=1, h2=2, …) — only relevant in subsection mode. */
  level: number;
  headingText: string;
  /** Lines of body content (no heading). */
  body: string[];
}

/**
 * Split a markdown document into IngestCandidates.
 *
 *   - When `section` is given, locate the first heading at any level
 *     whose text contains the section string (case-insensitive); scope
 *     parsing to content until the next heading at the SAME or HIGHER
 *     level. If no heading matches, returns [].
 *   - Within scope, decide split mode by which appears first: an H3
 *     subsection or a top-level bullet. That decision applies to the
 *     whole file (or whole section). Mixed files produce predictable
 *     output rather than clever interleaving.
 */
export function parseMarkdownItems(
  text: string,
  opts: { section?: string } = {},
): IngestCandidate[] {
  const rawLines = text.split(/\r?\n/);
  const lines: Array<{ no: number; raw: string }> = rawLines.map((raw, i) => ({
    no: i + 1,
    raw,
  }));

  // Scope to the section if requested.
  let scope = lines;
  if (opts.section) {
    const wanted = opts.section.toLowerCase();
    let startIdx = -1;
    let headingLevel = 0;
    for (let i = 0; i < lines.length; i++) {
      const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i]!.raw);
      if (match && match[2]!.toLowerCase().includes(wanted)) {
        startIdx = i + 1;
        headingLevel = match[1]!.length;
        break;
      }
    }
    if (startIdx === -1) return [];
    let endIdx = lines.length;
    for (let i = startIdx; i < lines.length; i++) {
      const m = /^(#{1,6})\s+/.exec(lines[i]!.raw);
      if (m && m[1]!.length <= headingLevel) {
        endIdx = i;
        break;
      }
    }
    scope = lines.slice(startIdx, endIdx);
  }

  // Decide mode: H3 first or top-level bullet first?
  let firstH3 = -1;
  let firstBullet = -1;
  for (let i = 0; i < scope.length; i++) {
    const raw = scope[i]!.raw;
    if (firstH3 === -1 && /^###\s+\S/.test(raw)) firstH3 = i;
    if (firstBullet === -1 && /^[-*]\s+\S/.test(raw)) firstBullet = i;
    if (firstH3 !== -1 && firstBullet !== -1) break;
  }
  if (firstH3 === -1 && firstBullet === -1) return [];
  const mode: "subsection" | "bullet" =
    firstH3 !== -1 && (firstBullet === -1 || firstH3 < firstBullet)
      ? "subsection"
      : "bullet";

  if (mode === "subsection") {
    const sections: RawSection[] = [];
    let cur: RawSection | null = null;
    for (const line of scope) {
      // Match ANY heading (H1+); the level decides what to do.
      // Real dogfood showed the prior `###+` regex absorbed H1/H2
      // headings into the previous H3 section's body — Logout's
      // body grew from ~600 chars to 3112 by eating the whole rest
      // of the file past its H3, then FTS surfaced phantom matches
      // because the body contained tokens from unrelated sections.
      const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line.raw);
      if (m) {
        const level = m[1]!.length;
        if (level <= 3) {
          // Any H1 / H2 / H3 closes the current H3 section. We only
          // START a new section for H3 (matching the original intent
          // of "subsection mode = H3 records").
          if (cur) sections.push(cur);
          cur =
            level === 3
              ? {
                  startLine: line.no,
                  level,
                  headingText: m[2]!.trim(),
                  body: [],
                }
              : null;
        } else if (cur) {
          // H4+ stays inside the current H3 section's body — it's a
          // sub-heading inside the section, not a new section.
          cur.body.push(line.raw);
        }
      } else if (cur) {
        cur.body.push(line.raw);
      }
    }
    if (cur) sections.push(cur);
    return sections
      .map((s) => candidateFromSection(s))
      .filter((c): c is IngestCandidate => c !== null);
  }

  // Bullet mode: every top-level bullet block is a candidate.
  const bullets: Array<{ startLine: number; lines: string[] }> = [];
  let cur: { startLine: number; lines: string[] } | null = null;
  for (const line of scope) {
    const m = /^[-*]\s+(.+)$/.exec(line.raw);
    if (m) {
      if (cur) bullets.push(cur);
      cur = { startLine: line.no, lines: [m[1]!] };
    } else if (cur && /^\s+\S/.test(line.raw)) {
      // Continuation line (indented).
      cur.lines.push(line.raw.trim());
    } else if (cur && line.raw.trim() === "") {
      // Blank line — bullet ends.
      bullets.push(cur);
      cur = null;
    }
  }
  if (cur) bullets.push(cur);
  return bullets
    .map((b) => candidateFromBullet(b))
    .filter((c): c is IngestCandidate => c !== null);
}

function candidateFromSection(s: RawSection): IngestCandidate | null {
  const bodyText = s.body.join("\n").trim();
  if (bodyText.length < MIN_CANDIDATE_BODY_CHARS) return null;
  // First non-blank paragraph is the summary.
  const paragraphs = bodyText.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  const summarySource = paragraphs[0] ?? bodyText;
  const summary = summarySource.replace(/\s+/g, " ").trim().slice(0, SUMMARY_MAX);
  return {
    title: s.headingText,
    summary,
    body: bodyText,
    sourceLine: s.startLine,
  };
}

function candidateFromBullet(b: {
  startLine: number;
  lines: string[];
}): IngestCandidate | null {
  const full = b.lines.join(" ").replace(/\s+/g, " ").trim();
  if (full.length < MIN_CANDIDATE_BODY_CHARS) return null;
  // Title: first sentence (up to ". ") OR truncated head.
  const sentenceCut = full.indexOf(". ");
  const title =
    sentenceCut > 0 && sentenceCut < BULLET_TITLE_MAX
      ? full.slice(0, sentenceCut)
      : full.slice(0, BULLET_TITLE_MAX).trim();
  const summary = full.slice(0, SUMMARY_MAX);
  return { title, summary, body: full, sourceLine: b.startLine };
}

/**
 * Synthesise a per-record source URL from a base URL + line ref. If
 * the base looks like a GitHub blob URL, append `#L<line>` so the
 * reviewer can jump straight to the right line; otherwise just keep
 * the base URL.
 */
export function deriveItemSource(
  base: string | undefined,
  line: number,
): string | undefined {
  if (!base) return undefined;
  if (/^https?:\/\/github\.com\//.test(base)) {
    return `${base}#L${line}`;
  }
  return base;
}
