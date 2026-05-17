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
      const m = /^(###+)\s+(.+?)\s*$/.exec(line.raw);
      if (m) {
        if (cur) sections.push(cur);
        cur = {
          startLine: line.no,
          level: m[1]!.length,
          headingText: m[2]!.trim(),
          body: [],
        };
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
