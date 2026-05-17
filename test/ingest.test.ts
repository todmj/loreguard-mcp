/**
 * `loreguard ingest-md` — markdown → draft suggest_lore pipeline.
 * Tests cover the pure parser; CLI integration is verified by
 * exercising parseMarkdownItems against fixtures + suggestLore against
 * an in-memory DB.
 */
import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  deriveItemSource,
  intentFilenameDenied,
  parseMarkdownItems,
  scoreCandidate,
} from "../src/cli/ingest.js";
import { listDrafts, suggestLore } from "../src/core/lore.js";
import { runMigrations } from "../src/db/migrations.js";
import type { Database } from "better-sqlite3";

function newDb(): Database {
  const db = new BetterSqlite3(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

describe("parseMarkdownItems — subsection mode", () => {
  it("splits an H3-driven file into one candidate per H3", () => {
    const md = `# Project

## Decisions

### Use Argon2id for password hashing
Platform sec ruling — bcrypt out as of Q3 2025.
See ADR-014.

### Webhook retries cap at 2h
Unbounded retries DoS'd downstream once. Cap added per INC-411.
Use exponential backoff.
`;
    const items = parseMarkdownItems(md);
    expect(items.map((i) => i.title)).toEqual([
      "Use Argon2id for password hashing",
      "Webhook retries cap at 2h",
    ]);
    expect(items[0]!.summary).toContain("Platform sec ruling");
    expect(items[0]!.body).toContain("ADR-014");
  });

  it("filters items shorter than 30 chars", () => {
    const md = `### Tiny\nTBD\n\n### Real one\nThis subsection has plenty of body text to qualify as a real candidate.\n`;
    const items = parseMarkdownItems(md);
    expect(items.map((i) => i.title)).toEqual(["Real one"]);
  });

  it("--section scope restricts parsing to one heading's range", () => {
    const md = `## Things That Don't Catch People Out
### Boring rule one
Some boring content that should be ignored when scoping to the other section.

## Things That Catch People Out
### Surprising gotcha A
Detail about gotcha A — long enough to clear the noise threshold easily.

### Surprising gotcha B
Detail about gotcha B — also long enough to be a real candidate record.

## After
### Should not appear
Even though this is an H3, the scope ended at the previous H2 above us.
`;
    const items = parseMarkdownItems(md, {
      section: "Things That Catch People Out",
    });
    expect(items.map((i) => i.title)).toEqual([
      "Surprising gotcha A",
      "Surprising gotcha B",
    ]);
  });

  it("--section returns [] when the heading is not found", () => {
    const md = "### Real\nplenty of body text here to make it real\n";
    const items = parseMarkdownItems(md, { section: "Nonexistent" });
    expect(items).toEqual([]);
  });

  it("H3 section body is bounded by next H1/H2/H3 — not absorbed past the next H2", () => {
    // Real dogfood bug: AUTHENTICATION.md's "### Logout" section had
    // body length 3112 because it absorbed everything until EOF —
    // including the "## Cross-Site Request Forgery" section that
    // followed. FTS then surfaced phantom matches on tokens that
    // lived in unrelated sections.
    const md = `# Auth Doc
## Sessions
### Logout
The logout endpoint revokes the refresh token server-side. Plenty of bytes here to qualify as a real candidate body for the parser.

## Cross-Site Request Forgery
This section is about XSRF tokens and state-mutating requests. Must NOT be in Logout body.
Anti-forgery tokens are written as cookies.

### Token rotation
This is a deeper H3 in a different parent H2. Token rotation is its own concern with substantial content here.
`;
    const items = parseMarkdownItems(md);
    const logout = items.find((i) => i.title === "Logout")!;
    expect(logout).toBeDefined();
    expect(logout.body).toContain("revokes the refresh token");
    // Words that ONLY exist in the H2 section after Logout. If the
    // parser absorbed the H2 body, these would leak in.
    expect(logout.body).not.toContain("XSRF");
    expect(logout.body).not.toContain("Anti-forgery");
    expect(logout.body).not.toContain("Token rotation");
  });

  it("H4+ stays inside its parent H3 section (sub-headings don't fragment)", () => {
    const md = `### Section A
intro to A. Plenty long enough to qualify on its own without the sub-sections being absorbed.

#### Sub-A1
sub content one. More long body content to ensure this passes the noise floor.

#### Sub-A2
sub content two. More long body content to ensure this passes the noise floor as well.

### Section B
body of B is also long enough to qualify as a real candidate record for the corpus.
`;
    const items = parseMarkdownItems(md);
    expect(items.map((i) => i.title)).toEqual(["Section A", "Section B"]);
    const a = items[0]!;
    // H4 sub-headings + their content should all be inside A's body.
    expect(a.body).toContain("Sub-A1");
    expect(a.body).toContain("sub content one");
    expect(a.body).toContain("Sub-A2");
    expect(a.body).toContain("sub content two");
    // But not B's content.
    expect(a.body).not.toContain("body of B");
  });
});

describe("parseMarkdownItems — bullet mode", () => {
  it("treats top-level bullets as candidates when no H3 precedes", () => {
    const md = `# Repo conventions

- All public APIs must include timezone offsets in dates. INC-411 was caused by a naive timestamp comparison.
- Migrations are append-only — never edit a shipped migration; add a new one.
- Builds run \`pnpm run build\` not \`tsc\` directly so the prepublish hook fires.
`;
    const items = parseMarkdownItems(md);
    expect(items).toHaveLength(3);
    expect(items[0]!.title.startsWith("All public APIs must include")).toBe(
      true,
    );
    expect(items[1]!.body).toContain("Migrations are append-only");
  });

  it("first-of-(H3, bullet) wins for the whole file", () => {
    // H3 appears first, so the lone bullet later should NOT be a candidate.
    const md = `### Subsection wins
Plenty of body text to qualify as a real H3 candidate so the heuristic sticks.

- this lone bullet should not be parsed because subsection mode is locked
`;
    const items = parseMarkdownItems(md);
    expect(items.map((i) => i.title)).toEqual(["Subsection wins"]);
  });

  it("skips bullets under the noise threshold", () => {
    const md = `- ok\n- This bullet is long enough to qualify as a real candidate record for the corpus.\n`;
    const items = parseMarkdownItems(md);
    expect(items).toHaveLength(1);
    expect(items[0]!.title.length).toBeGreaterThan(20);
  });
});

describe("deriveItemSource", () => {
  it("appends #L<line> to github blob URLs", () => {
    expect(
      deriveItemSource(
        "https://github.com/foo/bar/blob/main/CLAUDE.md",
        42,
      ),
    ).toBe("https://github.com/foo/bar/blob/main/CLAUDE.md#L42");
  });
  it("returns non-github URLs verbatim", () => {
    expect(deriveItemSource("https://example.com/doc", 1)).toBe(
      "https://example.com/doc",
    );
  });
  it("returns undefined when no base", () => {
    expect(deriveItemSource(undefined, 1)).toBeUndefined();
  });
});

describe("ingest → suggestLore round-trip", () => {
  it("each parsed item lands as a DRAFT via suggestLore", () => {
    const db = newDb();
    const md = `### One
First candidate body, plenty long.

### Two
Second candidate body, also plenty long.
`;
    const items = parseMarkdownItems(md);
    for (const item of items) {
      suggestLore(db, {
        title: item.title,
        summary: item.summary,
        body: item.body,
        tags: ["imported", "imported-from:test-fixture"],
      });
    }
    const drafts = listDrafts(db);
    expect(drafts.map((d) => d.title).sort()).toEqual(["One", "Two"]);
    for (const d of drafts) {
      expect(d.status).toBe("draft");
      expect(d.tags).toContain("imported");
    }
  });
});

describe("intentFilenameDenied — filename deny-list (derived from real betbridge data)", () => {
  it("matches plan / status / spec / roadmap files (the 80% noise sources)", () => {
    const denied = [
      "BUILD_PROGRESS.md",
      "build_progress.md",
      "PRIORITY_PLAN.md",
      "DEPLOYMENT_EXECUTION_PLAN.md",
      "E2E_USABILITY_PLAN.md",
      "USABILITY_PLAN.md",
      "ROADMAP.md",
      "PRODUCT_SPEC.md",
      "SPEC_DRIVEN_DESIGN.md",
      "team_status_q3.md",
      "backlog-2026.md",
      "todo-this-week.md",
    ];
    for (const f of denied) {
      expect(intentFilenameDenied(f)).not.toBeNull();
    }
  });

  it("allows real knowledge-doc filenames (the 20% lore-worthy sources)", () => {
    const allowed = [
      "ARCHITECTURE.md",
      "AUTHENTICATION.md",
      "CONFIGURATION.md",
      "INTEGRATION_GUIDE.md",
      "OPERATIONS.md",
      "SECRETS.md",
      "SECURITY.md",
      "HARDCODED_AUDIT.md", // "audit" not in deny-list — real audit report
      "FULL_CONTEXT_DUMP.md", // "dump" too broad to deny on
      "CLAUDE.md",
      "ADR-014-password-hashing.md",
      "MIGRATIONS.md",
    ];
    for (const f of allowed) {
      expect(intentFilenameDenied(f)).toBeNull();
    }
  });
});

describe("scoreCandidate — content-shape filter", () => {
  function candidate(
    fields: Partial<{ title: string; summary: string; body: string }>,
  ) {
    return {
      title: fields.title ?? "x",
      summary: fields.summary ?? "x",
      body: fields.body ?? "x",
      sourceLine: 1,
    };
  }

  it("hard-rejects collapsed title === summary === body bullets", () => {
    const r = scoreCandidate(
      candidate({
        title: "A description of the vulnerability and the potential impact",
        summary: "A description of the vulnerability and the potential impact",
        body: "A description of the vulnerability and the potential impact",
      }),
    );
    expect(r.pass).toBe(false);
    expect(r.reasons[0]).toMatch(/collapsed/);
  });

  it("hard-rejects date-stamped status headings", () => {
    expect(
      scoreCandidate(
        candidate({
          title: "Integration Tests — Testcontainers (2026-03-24)",
          body: "Some long body with imperatives like must and should that would otherwise pass scoring easily because of the markers.",
        }),
      ).pass,
    ).toBe(false);
    expect(
      scoreCandidate(
        candidate({
          title: "7. Configurable Outbound Template (In Progress — 2026-03-21)",
          body: "x".repeat(300),
        }),
      ).pass,
    ).toBe(false);
  });

  it("passes real lore with an imperative (must / should / etc.)", () => {
    const r = scoreCandidate(
      candidate({
        title: "Use Argon2id for password hashing",
        summary: "We must use Argon2id with m=64MB, t=3, p=4.",
        body: "All services should use the shared crypto package. Do not roll your own. INC-411 was caused by a bcrypt 72-byte truncation bug.",
      }),
    );
    expect(r.pass).toBe(true);
    expect(r.score).toBeGreaterThan(0);
  });

  it("passes short-but-durable facts via fact markers ('Customer IDs are tenant-scoped')", () => {
    const r = scoreCandidate(
      candidate({
        title: "Customer IDs are tenant-scoped",
        summary: "Customer IDs are scoped to a single tenant.",
        body: "Customer IDs are scoped to a single tenant; cross-tenant lookups are not supported. The resolver rejects any query that crosses the boundary.",
      }),
    );
    expect(r.pass).toBe(true);
    expect(r.reasons.some((rr) => rr.includes("fact marker"))).toBe(true);
  });

  it("rejects UI spec bullets with no rule/fact markers and a short body", () => {
    const r = scoreCandidate(
      candidate({
        title: "Cards: Suppliers Connected: 3/4 | Events Today: 127",
        summary: "Cards laid out in a grid",
        body: "Cards laid out in a grid, one per supplier, with metrics.",
      }),
    );
    expect(r.pass).toBe(false);
  });

  it("penalises future-tense markers (planned: / plan to / target: / will / todo)", () => {
    const r = scoreCandidate(
      candidate({
        title: "Multi-cloud abstractions",
        body: "Planned: support multiple managed services. Target: Q3 next year. We will deliver this when the second customer arrives.",
      }),
    );
    expect(r.pass).toBe(false);
    expect(r.reasons.some((rr) => rr.includes("future-tense"))).toBe(true);
  });

  it("does NOT match a marker inside a longer word ('must' inside 'mustard')", () => {
    const r = scoreCandidate(
      candidate({
        title: "Lunch options",
        body: "The kitchen has mustard, ketchup, and mayo. ".repeat(8),
      }),
    );
    expect(r.reasons.every((rr) => !rr.includes("imperative"))).toBe(true);
  });

  it("caps imperative scoring so spam can't game the threshold", () => {
    const r = scoreCandidate(
      candidate({
        title: "Test",
        body: "must must must must must must " + "long body ".repeat(30),
      }),
    );
    expect(r.score).toBeLessThanOrEqual(2);
  });
});
