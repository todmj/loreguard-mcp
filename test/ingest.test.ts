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
  parseMarkdownItems,
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
