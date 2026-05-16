/**
 * `lore induct` — repo onboarding interview. Walks a human through a
 * fixed list of high-signal questions and turns each non-blank answer
 * into a DRAFT lore record. Nothing lands as `active` here — promotion
 * is done via the normal `lore review` flow, which is the existing
 * trust gate.
 *
 * Why drafts: the induction is a cold-start aid, not an authority. The
 * person answering may be wrong, partial, or paraphrasing tribal
 * knowledge that needs sharpening. The review step is the quality
 * filter.
 *
 * The module is split into a pure `runInduct(db, opts)` that consumes a
 * list of `InductionAnswer` objects (so tests can drive it without
 * mocking readline) and the CLI wrapper in `cli/index.ts` that builds
 * that list interactively.
 */
import type { Database } from "better-sqlite3";

import { suggestLore } from "../core/lore.js";

/**
 * 90 days from "now". The induction draft includes a reviewAfter
 * because tribal knowledge captured this way ages quickly — a quarterly
 * re-check forces someone to confirm it's still true.
 */
export const INDUCT_DEFAULT_REVIEW_AFTER_DAYS = 90;

/** Tag carried by every record produced by induction. */
export const INDUCT_TAG = "induction";

export interface InductionQuestion {
  /** Stable identifier (used for the auto-title and tests). */
  readonly key: string;
  /** Short topic — becomes part of the draft title. */
  readonly topic: string;
  /** Prompt text shown to the user. */
  readonly prompt: string;
  /**
   * Extra tags layered on top of `induction` for this question (e.g. the
   * security-conventions question adds `security`). Helps later search.
   */
  readonly extraTags?: ReadonlyArray<string>;
}

/**
 * The fixed v0 question set. Order matters: easier / less-loaded
 * questions first to warm up; incident-shaped questions later.
 *
 * These are designed to elicit non-obvious, high-consequence knowledge
 * specifically. Generic "we use TypeScript" answers go in CLAUDE.md.
 */
/**
 * The five highest-signal questions from the full set, used by
 * `lore induct --short`. Picked for express onboarding: cover the bits
 * agents most often get wrong first (dangerous code, in-flight
 * migrations, hard invariants, hidden conventions, prior incidents).
 * Skips the meta-leaning prompts (decisions easy to miss, what to ask).
 *
 * Order matches the full-set order so the experience feels like a
 * subset, not a reshuffling.
 */
export const SHORT_INDUCTION_QUESTION_KEYS: ReadonlyArray<string> = [
  "dangerous-areas",
  "in-flight-migrations",
  "invariants",
  "non-obvious-conventions",
  "past-incidents",
];

export const INDUCTION_QUESTIONS: ReadonlyArray<InductionQuestion> = [
  {
    key: "dangerous-areas",
    topic: "Dangerous areas to edit without context",
    prompt:
      "What parts of this repo are dangerous for an agent to edit without context?\n" +
      "(legacy modules, side-effecting code, anything that bites if changed casually)",
  },
  {
    key: "old-patterns",
    topic: "Old patterns to NOT copy",
    prompt:
      "What old patterns exist in this codebase but should not be copied into new code?",
    extraTags: ["conventions"],
  },
  {
    key: "hidden-decisions",
    topic: "Architectural decisions easy to miss from code",
    prompt:
      "What architectural decisions have been made that are hard to spot from reading code alone?",
    extraTags: ["decisions"],
  },
  {
    key: "in-flight-migrations",
    topic: "Migrations / transitions in progress",
    prompt:
      "What migrations or transitions are currently incomplete?\n" +
      "(e.g. table A → table B, library X → Y, where both still co-exist)",
    extraTags: ["migrations"],
  },
  {
    key: "invariants",
    topic: "Invariants that must always hold",
    prompt:
      "What invariants must always hold? (cross-table constraints, ordering, " +
      "idempotency rules, state machines)",
    extraTags: ["invariants"],
  },
  {
    key: "authoritative-checks",
    topic: "Tests / contracts that are authoritative",
    prompt:
      "Which tests, checks, or contracts are considered authoritative when " +
      "in doubt? (more reliable than generated docs or README text)",
    extraTags: ["testing"],
  },
  {
    key: "external-surprises",
    topic: "External systems with surprising behaviour",
    prompt:
      "What external systems, queues, APIs, or jobs have surprising behaviour " +
      "an agent should know about before integrating?",
    extraTags: ["integrations"],
  },
  {
    key: "non-obvious-conventions",
    topic: "Non-obvious conventions",
    prompt:
      "What naming, timezone, auth, permissions, or data-modelling conventions " +
      "are non-obvious from the code?",
    extraTags: ["conventions"],
  },
  {
    key: "past-incidents",
    topic: "Failure modes that caused incidents",
    prompt:
      "What failure modes have caused incidents before, and what's the fix or guardrail?",
    extraTags: ["incident-lessons"],
  },
  {
    key: "contributor-questions",
    topic: "What a new contributor should ask first",
    prompt:
      "What should a new contributor ask before changing this repo? " +
      "(things that aren't written down anywhere yet)",
  },
];

export interface InductionAnswer {
  /** Must match an entry in INDUCTION_QUESTIONS by `key`. */
  readonly questionKey: string;
  /** Free-text answer. Empty / whitespace-only answers are skipped. */
  readonly answer: string;
  /** Optional source URL (PR / ADR / incident). */
  readonly source?: string;
}

export interface InductOptions {
  /** Answers in question order. Blank answers are skipped, not errored. */
  readonly answers: ReadonlyArray<InductionAnswer>;
  /** Repos to attach to every produced draft. */
  readonly repos?: ReadonlyArray<string>;
  /**
   * Override the default 90-day review window. Mostly useful for tests
   * that want a deterministic future date.
   */
  readonly reviewAfterDays?: number;
  /**
   * Override the "now" instant — for tests. Production callers leave
   * this undefined and we use the real clock.
   */
  readonly now?: Date;
}

export interface InductionDraftCreated {
  readonly id: string;
  readonly questionKey: string;
  readonly title: string;
}

export interface InductResult {
  readonly created: ReadonlyArray<InductionDraftCreated>;
  readonly skipped: ReadonlyArray<string>;
}

function findQuestion(key: string): InductionQuestion | undefined {
  return INDUCTION_QUESTIONS.find((q) => q.key === key);
}

/**
 * The short-mode question list as `InductionQuestion[]`, preserving the
 * order from `INDUCTION_QUESTIONS`. Used by `lore induct --short`.
 */
export function shortInductionQuestions(): InductionQuestion[] {
  const keys = new Set(SHORT_INDUCTION_QUESTION_KEYS);
  return INDUCTION_QUESTIONS.filter((q) => keys.has(q.key));
}

/**
 * Truncate at a paragraph boundary if there is one, otherwise at the
 * char cap. Used to build a short summary from a long answer without
 * cutting mid-sentence whenever possible.
 */
function shortSummary(answer: string, maxChars: number): string {
  const trimmed = answer.trim();
  const firstPara = trimmed.split(/\n{2,}/)[0] ?? trimmed;
  if (firstPara.length <= maxChars) return firstPara;
  return firstPara.slice(0, maxChars - 1).trimEnd() + "…";
}

/**
 * Pure entry-point. Iterates the answers, creates one DRAFT per non-blank
 * answer. Confidence: `medium` when a source is provided, `low` otherwise
 * — drafts can't claim `high` regardless (existing core invariant).
 */
export function runInduct(db: Database, opts: InductOptions): InductResult {
  const now = opts.now ?? new Date();
  const reviewAfterDays =
    opts.reviewAfterDays ?? INDUCT_DEFAULT_REVIEW_AFTER_DAYS;
  const reviewAfter = new Date(
    now.getTime() + reviewAfterDays * 86_400_000,
  ).toISOString();
  const created: InductionDraftCreated[] = [];
  const skipped: string[] = [];
  for (const a of opts.answers) {
    const q = findQuestion(a.questionKey);
    if (!q) {
      skipped.push(a.questionKey);
      continue;
    }
    if (a.answer.trim().length === 0) {
      skipped.push(a.questionKey);
      continue;
    }
    const title = `[induction] ${q.topic}`;
    const summary = shortSummary(a.answer, 500);
    const body =
      a.answer.trim() +
      `\n\n(induction session, ${now.toISOString().slice(0, 10)})`;
    const tags = [INDUCT_TAG, ...(q.extraTags ?? [])];
    const lore = suggestLore(db, {
      title,
      summary,
      body,
      repos: opts.repos ? [...opts.repos] : undefined,
      tags,
      source: a.source && a.source.trim() ? a.source.trim() : undefined,
      // Drafts can't claim `high` regardless (clampConfidence enforces).
      // Pass `medium` when we have a source so the clamp doesn't downgrade
      // it further to the default; `low` when we don't, to make the
      // weaker-trust signal visible at review time.
      confidence: a.source && a.source.trim() ? "medium" : "low",
      reviewAfter,
      author: "induction",
    });
    created.push({ id: lore.id, questionKey: q.key, title });
  }
  return { created, skipped };
}

/**
 * Best-effort short repo name from a git remote URL.
 *
 *   git@github.com:owner/lore-mcp.git  → lore-mcp
 *   https://github.com/owner/lore-mcp  → lore-mcp
 *   https://gitlab.com/g/sub/proj.git  → proj
 *
 * Returns null when the input doesn't look like a remote we can parse;
 * the CLI then falls back to asking the user.
 */
export function shortRepoNameFromRemote(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  // Strip trailing .git
  const noGit = trimmed.replace(/\.git\/?$/, "");
  // SSH form: git@host:owner/name
  const sshMatch = /:([^/]+\/)*([^/]+)$/.exec(noGit);
  if (noGit.startsWith("git@") && sshMatch) {
    return sshMatch[2] ?? null;
  }
  // HTTPS form: https://host/owner/name
  try {
    const u = new URL(noGit);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length === 0) return null;
    return parts[parts.length - 1] ?? null;
  } catch {
    // Last resort — take the final path segment
    const parts = noGit.split("/").filter(Boolean);
    return parts.length > 0 ? (parts[parts.length - 1] ?? null) : null;
  }
}
