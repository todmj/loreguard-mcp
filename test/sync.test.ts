/**
 * `lore sync` — round-trip Markdown export/import. Guards the
 * properties team-sync needs to be trustworthy:
 *
 *   - export → import → export is lossless for the fields we round-trip
 *   - frontmatter parser handles scalars, arrays, booleans, ISO dates
 *   - restricted records and drafts are excluded by default
 *   - --include-restricted / --include-drafts unlock them
 *   - malformed files are skipped with a reason, not crash
 *   - status from frontmatter is authoritative on import (PR is the gate)
 */
import BetterSqlite3 from "better-sqlite3";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addLore, getLore, suggestLore } from "../src/core/lore.js";
import { runMigrations } from "../src/db/migrations.js";
import {
  exportToDir,
  importFromDir,
  parseFrontmatter,
  renderLoreMarkdown,
} from "../src/cli/sync.js";
import type { Database } from "better-sqlite3";

function newInMemoryDb(): Database {
  const db = new BetterSqlite3(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

describe("cli/sync — frontmatter parser", () => {
  it("parses scalars, booleans, and ISO-shaped strings", () => {
    const text =
      "---\n" +
      "id: abc12345\n" +
      "title: Some title with no special chars\n" +
      "restricted: false\n" +
      "createdAt: 2026-02-10T09:31:00.000Z\n" +
      "---\n" +
      "\n" +
      "body line 1\n" +
      "body line 2\n";
    const r = parseFrontmatter(text);
    expect(r).not.toBeNull();
    expect(r!.frontmatter["id"]).toBe("abc12345");
    expect(r!.frontmatter["restricted"]).toBe(false);
    expect(r!.frontmatter["createdAt"]).toBe("2026-02-10T09:31:00.000Z");
    expect(r!.body).toBe("body line 1\nbody line 2\n");
  });

  it("parses string arrays under `key:` followed by `  - item`", () => {
    const text =
      "---\n" +
      "id: x\n" +
      "title: t\n" +
      "summary: s\n" +
      "status: active\n" +
      "repos:\n" +
      "  - auth-svc\n" +
      "  - payments-svc\n" +
      "tags:\n" +
      "  - security\n" +
      "---\n" +
      "body\n";
    const r = parseFrontmatter(text);
    expect(r!.frontmatter["repos"]).toEqual(["auth-svc", "payments-svc"]);
    expect(r!.frontmatter["tags"]).toEqual(["security"]);
  });

  it("returns null when the file does not start with a frontmatter fence", () => {
    expect(parseFrontmatter("just a body\n")).toBeNull();
  });

  it("returns null when the frontmatter never closes", () => {
    expect(parseFrontmatter("---\nid: x\ntitle: t\n")).toBeNull();
  });

  it("handles JSON-quoted strings (colons, special chars)", () => {
    const text =
      "---\n" +
      "id: x\n" +
      'title: "Use https://example.com: a colon test"\n' +
      "summary: s\n" +
      "status: active\n" +
      "---\n" +
      "body\n";
    const r = parseFrontmatter(text);
    expect(r!.frontmatter["title"]).toBe(
      "Use https://example.com: a colon test",
    );
  });
});

describe("cli/sync — renderLoreMarkdown", () => {
  it("round-trips: render → parse yields the same field values", () => {
    const db = newInMemoryDb();
    const lore = addLore(db, {
      title: "Use https://example.com: keep colons working",
      summary: "s with: colon",
      body: "Body line one.\nBody line two.",
      repos: ["auth-svc", "payments-svc"],
      tags: ["security"],
      source: "https://example.com/adrs/14",
      confidence: "high",
      reviewAfter: "2026-12-31",
      author: "alice@example.com",
      team: "Platform",
    });
    const full = getLore(db, lore.id)!;
    const md = renderLoreMarkdown(full);
    const parsed = parseFrontmatter(md);
    expect(parsed).not.toBeNull();
    expect(parsed!.frontmatter["id"]).toBe(full.id);
    expect(parsed!.frontmatter["title"]).toBe(full.title);
    expect(parsed!.frontmatter["status"]).toBe("active");
    expect(parsed!.frontmatter["confidence"]).toBe("high");
    expect(parsed!.frontmatter["restricted"]).toBe(false);
    expect(parsed!.frontmatter["repos"]).toEqual([
      "auth-svc",
      "payments-svc",
    ]);
    expect(parsed!.frontmatter["tags"]).toEqual(["security"]);
    expect(parsed!.body.trim()).toBe(full.body);
  });
});

describe("cli/sync — export/import round-trip against the filesystem", () => {
  let db: Database;
  let dir: string;
  beforeEach(() => {
    db = newInMemoryDb();
    dir = mkdtempSync(join(tmpdir(), "lore-sync-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("exports active records to one .md per id, then imports them back losslessly", () => {
    const a = addLore(db, {
      title: "Argon2id default",
      summary: "Platform sec ruling.",
      body: "Body for argon record.",
      repos: ["auth-svc"],
      tags: ["security"],
      source: "https://example.com/adrs/14",
      confidence: "high",
    });
    const b = addLore(db, {
      title: "Migration style guide",
      summary: "Liquibase format.",
      body: "Body for migration record.",
      repos: ["billing-svc"],
      tags: ["db", "conventions"],
    });
    const exported = exportToDir(db, dir);
    expect(exported.written).toHaveLength(2);
    expect(exported.excluded.restricted).toBe(0);
    expect(exported.excluded.drafts).toBe(0);

    // Fresh DB; import. Both ids should round-trip.
    const db2 = newInMemoryDb();
    const result = importFromDir(db2, dir);
    expect(result.created).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.skipped).toEqual([]);
    const ra = getLore(db2, a.id)!;
    const rb = getLore(db2, b.id)!;
    expect(ra.title).toBe(a.title);
    expect(ra.body).toBe("Body for argon record.");
    expect(ra.repos).toEqual(["auth-svc"]);
    expect(ra.tags).toEqual(["security"]);
    expect(ra.source).toBe("https://example.com/adrs/14");
    expect(ra.confidence).toBe("high");
    expect(rb.tags).toEqual(["conventions", "db"]);
  });

  it("excludes drafts and restricted by default; opt-ins surface them", () => {
    addLore(db, { title: "active", summary: "s", body: "B" });
    suggestLore(db, { title: "draft one", summary: "s", body: "B" });
    addLore(db, {
      title: "restricted one",
      summary: "s",
      body: "B",
      restricted: true,
    });
    const defaultExport = exportToDir(db, dir);
    expect(defaultExport.written).toHaveLength(1);
    expect(defaultExport.excluded.restricted).toBe(1);
    expect(defaultExport.excluded.drafts).toBe(1);

    rmSync(dir, { recursive: true, force: true });
    const allOptins = exportToDir(db, dir, {
      includeDrafts: true,
      includeRestricted: true,
    });
    expect(allOptins.written).toHaveLength(3);
  });

  it("import second time updates rather than duplicates", () => {
    const a = addLore(db, {
      title: "v1",
      summary: "s",
      body: "B",
    });
    exportToDir(db, dir);

    // Edit the .md file in place.
    const path = join(dir, `${a.id}.md`);
    const text = readFileSync(path, "utf8");
    const edited = text.replace("title: v1", "title: v2 (edited)");
    writeFileSync(path, edited);

    const db2 = newInMemoryDb();
    // Insert the original first so the import path goes through UPDATE.
    addLore(db2, {
      title: "v1",
      summary: "s",
      body: "B",
    });
    // The local id won't match the export's id, so first import will CREATE.
    const first = importFromDir(db2, dir);
    expect(first.created).toBe(1);
    expect(first.updated).toBe(0);
    // Second import: same files, no changes → all rows should UPDATE.
    const second = importFromDir(db2, dir);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);
    expect(getLore(db2, a.id)?.title).toBe("v2 (edited)");
  });

  it("skips files without frontmatter and reports a reason", () => {
    writeFileSync(join(dir, "rogue.md"), "no frontmatter here\n");
    const result = importFromDir(newInMemoryDb(), dir);
    expect(result.created).toBe(0);
    expect(result.skipped).toEqual([
      { file: "rogue.md", reason: "no frontmatter" },
    ]);
  });

  it("skips a restricted file by default and notes why; --include-restricted imports it", () => {
    addLore(db, {
      title: "Restricted note",
      summary: "s",
      body: "B",
      restricted: true,
    });
    exportToDir(db, dir, { includeRestricted: true });
    const db2 = newInMemoryDb();
    const def = importFromDir(db2, dir);
    expect(def.created).toBe(0);
    expect(def.skipped[0]?.reason).toContain("restricted");
    const db3 = newInMemoryDb();
    const opt = importFromDir(db3, dir, { includeRestricted: true });
    expect(opt.created).toBe(1);
  });

  it("respects status declared in frontmatter (PR is the gate)", () => {
    // Manually write a deprecated record's .md, import, expect deprecated.
    const id = "abcd1234";
    const md =
      "---\n" +
      `id: ${id}\n` +
      "title: Old policy\n" +
      "summary: deprecated by team vote\n" +
      "status: deprecated\n" +
      "confidence: medium\n" +
      "restricted: false\n" +
      "createdAt: 2026-01-01T00:00:00.000Z\n" +
      "updatedAt: 2026-01-02T00:00:00.000Z\n" +
      "---\n" +
      "\n" +
      "Body.\n";
    writeFileSync(join(dir, `${id}.md`), md);
    const result = importFromDir(db, dir);
    expect(result.created).toBe(1);
    expect(getLore(db, id)?.status).toBe("deprecated");
  });

  it("--clean removes stale <id>.md files in the target dir before writing", () => {
    addLore(db, { title: "current", summary: "s", body: "B" });
    // Place a stale lore-id-looking file in the dir; --clean should drop it.
    const stale = join(dir, "abcd2345.md");
    writeFileSync(stale, "---\nid: abcd2345\n---\nstale\n");
    const result = exportToDir(db, dir, { clean: true });
    expect(result.removed.map((p) => p.split("/").pop()).sort()).toContain(
      "abcd2345.md",
    );
    // The stale file is gone; only the current record's .md remains.
    const remaining = require("node:fs")
      .readdirSync(dir)
      .filter((f: string) => f.endsWith(".md"))
      .sort();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).not.toBe("abcd2345.md");
  });

  it("--clean does NOT remove hand-written .md files (only 8-char id pattern)", () => {
    addLore(db, { title: "current", summary: "s", body: "B" });
    writeFileSync(join(dir, "CONTRIBUTING.md"), "# How to contribute\n");
    writeFileSync(join(dir, "README.md"), "# Repo lore\n");
    const result = exportToDir(db, dir, { clean: true });
    expect(result.removed).toEqual([]);
    const names = readdirSync(dir).sort();
    expect(names).toContain("CONTRIBUTING.md");
    expect(names).toContain("README.md");
  });

  it("without --clean, stale <id>.md files survive across exports", () => {
    addLore(db, { title: "current", summary: "s", body: "B" });
    writeFileSync(join(dir, "abcd2345.md"), "---\nid: abcd2345\n---\nstale\n");
    const result = exportToDir(db, dir);
    expect(result.removed).toEqual([]);
    const names = readdirSync(dir);
    expect(names).toContain("abcd2345.md");
  });

  it("skips files with missing required fields and lists each reason", () => {
    writeFileSync(
      join(dir, "no-id.md"),
      "---\ntitle: t\nsummary: s\nstatus: active\n---\nbody\n",
    );
    writeFileSync(
      join(dir, "bad-status.md"),
      "---\nid: x\ntitle: t\nsummary: s\nstatus: nonsense\n---\nbody\n",
    );
    const result = importFromDir(db, dir);
    expect(result.created).toBe(0);
    expect(result.skipped.map((s) => s.file).sort()).toEqual([
      "bad-status.md",
      "no-id.md",
    ]);
  });
});
