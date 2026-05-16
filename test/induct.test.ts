/**
 * `loreguard induct` — repo onboarding interview. Tests drive `runInduct`
 * directly with canned answers; the interactive readline wrapper in
 * cli/index.ts is exercised by hand. Pure-function tests focus on the
 * invariants worth guarding:
 *
 *   - blank answers skip rather than throw
 *   - unknown question keys skip rather than throw
 *   - every created draft is `status: draft`, tagged 'induction', and
 *     has a reviewAfter set ~90 days out
 *   - source presence drives confidence (medium with, low without)
 *   - shortRepoNameFromRemote handles ssh / https / .git suffixes
 */
import BetterSqlite3 from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { getLore } from "../src/core/lore.js";
import {
  INDUCT_DEFAULT_REVIEW_AFTER_DAYS,
  INDUCT_TAG,
  INDUCTION_QUESTIONS,
  runInduct,
  SHORT_INDUCTION_QUESTION_KEYS,
  shortInductionQuestions,
  shortRepoNameFromRemote,
} from "../src/cli/induct.js";
import { runMigrations } from "../src/db/migrations.js";
import type { Database } from "better-sqlite3";

function newInMemoryDb(): Database {
  const db = new BetterSqlite3(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

describe("cli/induct", () => {
  let db: Database;
  beforeEach(() => {
    db = newInMemoryDb();
  });

  it("creates one DRAFT per non-blank answer", () => {
    const { created, skipped } = runInduct(db, {
      answers: [
        {
          questionKey: "dangerous-areas",
          answer: "Don't touch the legacy webhook parser.",
          source: "https://example.com/adrs/9",
        },
        {
          questionKey: "old-patterns",
          answer: "", // blank — should skip
        },
        {
          questionKey: "invariants",
          answer: "All timestamps stored in UTC.",
        },
      ],
    });
    expect(created).toHaveLength(2);
    expect(skipped).toEqual(["old-patterns"]);
    for (const c of created) {
      const full = getLore(db, c.id);
      expect(full?.status).toBe("draft");
    }
  });

  it("tags every created record with 'induction' and the question's extraTags", () => {
    const { created } = runInduct(db, {
      answers: [
        {
          questionKey: "past-incidents",
          answer:
            "Webhook retries went unbounded in INC-411; cap added to 2h backoff.",
        },
      ],
    });
    expect(created).toHaveLength(1);
    const full = getLore(db, created[0]!.id)!;
    // Question 'past-incidents' has extraTags: ['incident-lessons']
    expect(full.tags).toContain(INDUCT_TAG);
    expect(full.tags).toContain("incident-lessons");
  });

  it("attaches caller-supplied repos to every draft", () => {
    const { created } = runInduct(db, {
      answers: [
        {
          questionKey: "invariants",
          answer: "All timestamps stored in UTC.",
        },
      ],
      repos: ["payments-svc"],
    });
    const full = getLore(db, created[0]!.id)!;
    expect(full.repos).toContain("payments-svc");
  });

  it("sets reviewAfter ~90 days from `now` by default", () => {
    const fixed = new Date("2026-05-01T00:00:00.000Z");
    const { created } = runInduct(db, {
      answers: [
        {
          questionKey: "invariants",
          answer: "All timestamps stored in UTC.",
        },
      ],
      now: fixed,
    });
    const full = getLore(db, created[0]!.id)!;
    const expected = new Date(
      fixed.getTime() + INDUCT_DEFAULT_REVIEW_AFTER_DAYS * 86_400_000,
    ).toISOString();
    expect(full.reviewAfter).toBe(expected);
  });

  it("confidence is 'medium' when sourced, 'low' otherwise (drafts can't be high)", () => {
    const { created } = runInduct(db, {
      answers: [
        {
          questionKey: "dangerous-areas",
          answer: "Don't touch the legacy webhook parser.",
          source: "https://example.com/adrs/9",
        },
        {
          questionKey: "invariants",
          answer: "All timestamps stored in UTC.",
        },
      ],
    });
    const sourced = getLore(db, created[0]!.id)!;
    const sourceless = getLore(db, created[1]!.id)!;
    expect(sourced.confidence).toBe("medium");
    expect(sourceless.confidence).toBe("low");
  });

  it("title is auto-prefixed with [induction] and the question topic", () => {
    const { created } = runInduct(db, {
      answers: [
        {
          questionKey: "invariants",
          answer: "All timestamps stored in UTC.",
        },
      ],
    });
    expect(created[0]!.title).toBe(
      "[induction] Invariants that must always hold",
    );
  });

  it("body includes the answer plus an 'induction session, <date>' footer", () => {
    const fixed = new Date("2026-05-16T00:00:00.000Z");
    const { created } = runInduct(db, {
      answers: [
        {
          questionKey: "invariants",
          answer: "All timestamps in UTC.",
        },
      ],
      now: fixed,
    });
    const full = getLore(db, created[0]!.id)!;
    expect(full.body).toContain("All timestamps in UTC.");
    expect(full.body).toContain("(induction session, 2026-05-16)");
  });

  it("truncates summary at ~500 chars while keeping the body intact", () => {
    const long = "A".repeat(800);
    const { created } = runInduct(db, {
      answers: [{ questionKey: "invariants", answer: long }],
    });
    const full = getLore(db, created[0]!.id)!;
    expect(full.summary.length).toBeLessThanOrEqual(500);
    expect(full.body.startsWith(long)).toBe(true);
  });

  it("skips unknown question keys rather than throwing", () => {
    const { created, skipped } = runInduct(db, {
      answers: [{ questionKey: "made-up-key", answer: "anything" }],
    });
    expect(created).toEqual([]);
    expect(skipped).toEqual(["made-up-key"]);
  });

  it("INDUCTION_QUESTIONS has unique keys (sanity)", () => {
    const keys = INDUCTION_QUESTIONS.map((q) => q.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("shortInductionQuestions (--short subset)", () => {
  it("returns exactly 5 questions", () => {
    expect(shortInductionQuestions()).toHaveLength(5);
    expect(SHORT_INDUCTION_QUESTION_KEYS).toHaveLength(5);
  });

  it("every short-mode key exists in the full INDUCTION_QUESTIONS list", () => {
    const fullKeys = new Set(INDUCTION_QUESTIONS.map((q) => q.key));
    for (const k of SHORT_INDUCTION_QUESTION_KEYS) {
      expect(fullKeys.has(k)).toBe(true);
    }
  });

  it("preserves the original question order (subset, not reshuffle)", () => {
    const full = INDUCTION_QUESTIONS.map((q) => q.key);
    const short = shortInductionQuestions().map((q) => q.key);
    // Each key in `short` should appear in `full` in the same relative order.
    let cursor = 0;
    for (const k of short) {
      const next = full.indexOf(k, cursor);
      expect(next).toBeGreaterThanOrEqual(cursor);
      cursor = next + 1;
    }
  });

  it("covers the five highest-signal topics agreed in the v0 plan", () => {
    expect(SHORT_INDUCTION_QUESTION_KEYS).toEqual([
      "dangerous-areas",
      "in-flight-migrations",
      "invariants",
      "non-obvious-conventions",
      "past-incidents",
    ]);
  });
});

describe("shortRepoNameFromRemote", () => {
  it("parses SSH form", () => {
    expect(
      shortRepoNameFromRemote("git@github.com:owner/loreguard-mcp.git"),
    ).toBe("loreguard-mcp");
  });
  it("parses HTTPS form, with or without .git", () => {
    expect(
      shortRepoNameFromRemote("https://github.com/owner/loreguard-mcp.git"),
    ).toBe("loreguard-mcp");
    expect(
      shortRepoNameFromRemote("https://github.com/owner/loreguard-mcp"),
    ).toBe("loreguard-mcp");
  });
  it("parses GitLab-style nested groups", () => {
    expect(
      shortRepoNameFromRemote("https://gitlab.com/group/sub/proj.git"),
    ).toBe("proj");
  });
  it("returns null on empty input", () => {
    expect(shortRepoNameFromRemote("")).toBe(null);
    expect(shortRepoNameFromRemote("   ")).toBe(null);
  });
});
