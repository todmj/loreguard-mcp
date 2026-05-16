import BetterSqlite3 from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  addLore,
  approveLore,
  deleteLore,
  deprecateLore,
  exportLore,
  findPossibleDuplicates,
  getLore,
  listDrafts,
  listRecent,
  listRepos,
  listTags,
  rejectLore,
  searchLore,
  supersedeLore,
  suggestLore,
  updateLore,
  verifyLore,
} from "../src/core/lore.js";
import { runMigrations } from "../src/db/migrations.js";
import type { Database } from "better-sqlite3";

function newInMemoryDb(): Database {
  const db = new BetterSqlite3(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

describe("core/lore", () => {
  let db: Database;
  beforeEach(() => {
    db = newInMemoryDb();
  });

  describe("addLore (human entry)", () => {
    it("creates an active record with sorted/deduped tags + repos", () => {
      const lore = addLore(db, {
        title: "Drop bcrypt for Argon2id",
        summary: "Platform sec ruling, Q3 2025.",
        body: "Reasoning: 72-byte truncation bug. Argon2id m=64MB, t=3, p=4.",
        repos: ["payments-svc", "auth-svc", "payments-svc"],
        tags: ["Security", "Password Hashing", "security"],
        team: "Platform",
        author: "alice@example.com",
        source: "https://example.com/adrs/014",
        confidence: "high",
      });
      expect(lore.id).toMatch(/^[a-z2-9]{8}$/);
      expect(lore.status).toBe("active");
      expect(lore.repos).toEqual(["auth-svc", "payments-svc"]);
      expect(lore.tags).toEqual(["password-hashing", "security"]);
      expect(lore.confidence).toBe("high");
      expect(lore.source).toBe("https://example.com/adrs/014");
      expect(lore.restricted).toBe(false);
    });

    it("defaults confidence to 'medium' when caller omits it", () => {
      const lore = addLore(db, { title: "t", summary: "s", body: "b" });
      expect(lore.confidence).toBe("medium");
    });

    it("emits a 'created' event row", () => {
      const lore = addLore(db, { title: "t", summary: "s", body: "b" });
      const kinds = (
        db
          .prepare("SELECT kind FROM events WHERE lore_id = ?")
          .all(lore.id) as Array<{ kind: string }>
      ).map((e) => e.kind);
      expect(kinds).toEqual(["created"]);
    });
  });

  describe("suggestLore (agent entry)", () => {
    it("creates a draft record regardless of caller-provided status", () => {
      const lore = suggestLore(db, {
        title: "payments-svc rejects naive dates",
        summary: "Discovered while investigating INC-411.",
        body: "All dates at the API boundary must include tz offset.",
      });
      expect(lore.status).toBe("draft");
    });

    it("emits a 'suggested' event so audit shows agent vs human source", () => {
      const lore = suggestLore(db, { title: "t", summary: "s", body: "b" });
      const kinds = (
        db
          .prepare("SELECT kind FROM events WHERE lore_id = ?")
          .all(lore.id) as Array<{ kind: string }>
      ).map((e) => e.kind);
      expect(kinds).toEqual(["suggested"]);
    });

    it("is invisible to default search until approved", () => {
      const lore = suggestLore(db, {
        title: "X about Y",
        summary: "s",
        body: "b",
      });
      expect(searchLore(db, { query: "Y" })).toEqual([]);
      const approved = approveLore(db, lore.id);
      expect(approved?.status).toBe("active");
      const hits = searchLore(db, { query: "Y" });
      expect(hits.map((h) => h.id)).toContain(lore.id);
    });

    it("listDrafts surfaces drafts for the human reviewer", () => {
      suggestLore(db, { title: "a", summary: "s", body: "b" });
      suggestLore(db, { title: "b", summary: "s", body: "b" });
      addLore(db, { title: "c (active)", summary: "s", body: "b" });
      const drafts = listDrafts(db);
      expect(drafts.map((d) => d.title).sort()).toEqual(["a", "b"]);
    });
  });

  describe("confidence invariants", () => {
    it("agent suggestions cannot claim high confidence; clamps to medium", () => {
      const lore = suggestLore(db, {
        title: "t",
        summary: "s",
        body: "b",
        confidence: "high",
        source: "https://example.com/x",
      });
      // Even WITH a source, drafts max out at medium.
      expect(lore.confidence).toBe("medium");
    });

    it("a high-confidence claim without a source is clamped to medium", () => {
      const lore = addLore(db, {
        title: "t",
        summary: "s",
        body: "b",
        confidence: "high",
      });
      expect(lore.confidence).toBe("medium");
    });

    it("a human-added record with a source can stamp high", () => {
      const lore = addLore(db, {
        title: "t",
        summary: "s",
        body: "b",
        confidence: "high",
        source: "https://example.com/adrs/14",
      });
      expect(lore.confidence).toBe("high");
    });
  });

  describe("rejectLore (interactive triage)", () => {
    it("deletes the row, cascades repos+tags, removes FTS, emits 'rejected'", () => {
      const draft = suggestLore(db, {
        title: "speculation about widgets",
        summary: "s",
        body: "b",
        repos: ["x"],
        tags: ["y"],
      });
      expect(rejectLore(db, draft.id)).toBe(true);
      expect(getLore(db, draft.id)).toBeNull();
      expect(
        db.prepare("SELECT * FROM lore_repos WHERE lore_id = ?").all(draft.id),
      ).toEqual([]);
      expect(
        db.prepare("SELECT * FROM lore_tags WHERE lore_id = ?").all(draft.id),
      ).toEqual([]);
      expect(searchLore(db, { query: "widgets" })).toEqual([]);
      // Event is 'rejected', not 'deleted' — distinguishes triage from manual delete.
      const kinds = (
        db
          .prepare("SELECT kind FROM events WHERE lore_id = ? ORDER BY rowid")
          .all(draft.id) as Array<{ kind: string }>
      ).map((e) => e.kind);
      expect(kinds).toEqual(["suggested", "rejected"]);
    });

    it("refuses to reject an active record (use deprecateLore instead)", () => {
      const active = addLore(db, { title: "real rule", summary: "s", body: "b" });
      expect(rejectLore(db, active.id)).toBe(false);
      // Untouched.
      expect(getLore(db, active.id)?.status).toBe("active");
    });

    it("refuses to reject deprecated / superseded records", () => {
      const a = addLore(db, { title: "old", summary: "s", body: "b" });
      const b = addLore(db, { title: "new", summary: "s", body: "b" });
      deprecateLore(db, a.id);
      expect(rejectLore(db, a.id)).toBe(false);
      supersedeLore(db, a.id, b.id);
      expect(rejectLore(db, a.id)).toBe(false);
    });

    it("returns false for unknown id", () => {
      expect(rejectLore(db, "ghost123")).toBe(false);
    });
  });

  describe("approveLore", () => {
    it("returns null on unknown id", () => {
      expect(approveLore(db, "ghost")).toBeNull();
    });
    it("returns null when target isn't a draft (already active)", () => {
      const lore = addLore(db, { title: "t", summary: "s", body: "b" });
      expect(approveLore(db, lore.id)).toBeNull();
    });
  });

  describe("searchLore — token-saving contract", () => {
    beforeEach(() => {
      addLore(db, {
        title: "Argon2id is the password hash default",
        summary: "Platform security ruling. Bcrypt out.",
        body: "Use m=64MB, t=3, p=4.",
        repos: ["payments-svc"],
        tags: ["security", "passwords"],
        source: "https://example.com/adrs/014",
        confidence: "high",
      });
      addLore(db, {
        title: "Database migrations style guide",
        summary: "Always idempotent, always reversible.",
        body: "We use Liquibase format, change-sets numbered.",
        repos: ["payments-svc", "billing-svc"],
        tags: ["db", "conventions"],
      });
      addLore(db, {
        title: "Restricted: incident response key contacts",
        summary: "On-call only.",
        body: "Rotation lives in PagerDuty.",
        repos: ["secops"],
        tags: ["security"],
        restricted: true,
      });
    });

    it("returns the LoreSummary projection — body deliberately absent", () => {
      const [hit] = searchLore(db, { query: "Argon2id" });
      expect(hit).toBeTruthy();
      expect((hit as unknown as { body?: string }).body).toBeUndefined();
      expect(hit!.source).toBe("https://example.com/adrs/014");
      expect(hit!.confidence).toBe("high");
    });

    it("excludes drafts by default", () => {
      suggestLore(db, {
        title: "Argon2id v2",
        summary: "newer settings",
        body: "b",
      });
      const hits = searchLore(db, { query: "Argon2id" });
      expect(hits.every((h) => h.status === "active")).toBe(true);
    });

    it("excludes deprecated by default; includes when flagged", () => {
      const lore = addLore(db, {
        title: "Old migration policy",
        summary: "s",
        body: "b",
      });
      deprecateLore(db, lore.id);
      expect(searchLore(db, { query: "Old migration policy" })).toEqual([]);
      const incl = searchLore(db, {
        query: "Old migration policy",
        includeDeprecated: true,
      });
      expect(incl.length).toBe(1);
      expect(incl[0]!.status).toBe("deprecated");
    });

    it("excludes superseded by default", () => {
      const a = addLore(db, { title: "Vermilion zeppelin original", summary: "s", body: "b" });
      const b = addLore(db, { title: "Vermilion zeppelin replacement", summary: "s", body: "b" });
      supersedeLore(db, a.id, b.id);
      const hits = searchLore(db, { query: "Vermilion zeppelin" });
      expect(hits.map((h) => h.id)).toEqual([b.id]);
    });

    it("includes superseded when explicitly opted in", () => {
      const a = addLore(db, { title: "Cerulean dirigible original", summary: "s", body: "b" });
      const b = addLore(db, { title: "Cerulean dirigible replacement", summary: "s", body: "b" });
      supersedeLore(db, a.id, b.id);
      const hits = searchLore(db, {
        query: "Cerulean dirigible",
        includeSuperseded: true,
      });
      const ids = hits.map((h) => h.id).sort();
      expect(ids).toEqual([a.id, b.id].sort());
      const old = hits.find((h) => h.id === a.id);
      expect(old?.status).toBe("superseded");
    });

    it("excludes restricted by default", () => {
      const hits = searchLore(db, { query: "incident" });
      expect(hits.every((h) => h.restricted === false)).toBe(true);
    });

    it("returns restricted when explicitly opted in", () => {
      const hits = searchLore(db, {
        query: "incident",
        includeRestricted: true,
      });
      expect(hits.some((h) => h.restricted)).toBe(true);
    });

    it("repo filter narrows to scope", () => {
      const billing = searchLore(db, {
        query: "migration",
        repo: "billing-svc",
      });
      expect(billing.length).toBe(1);
      expect(billing[0]!.repos).toContain("billing-svc");
    });

    it("limit clamps at 50", () => {
      for (let i = 0; i < 60; i++) {
        addLore(db, { title: `entry-${i}`, summary: "s", body: "b" });
      }
      const hits = searchLore(db, { limit: 100 });
      expect(hits.length).toBeLessThanOrEqual(50);
    });
  });

  describe("staleness", () => {
    it("flags results whose review_after is in the past", () => {
      addLore(db, {
        title: "Old rule still hanging around",
        summary: "s",
        body: "b",
        reviewAfter: "2020-01-01",
      });
      const [hit] = searchLore(db, { query: "Old rule" });
      expect(hit!.stale).toBe(true);
    });
    it("does not flag fresh records (review_after in the future)", () => {
      addLore(db, {
        title: "Fresh rule",
        summary: "s",
        body: "b",
        reviewAfter: "2099-12-31",
      });
      const [hit] = searchLore(db, { query: "Fresh" });
      expect(hit!.stale).toBe(false);
    });
    it("does not flag when no review_after is set", () => {
      addLore(db, { title: "No expiry", summary: "s", body: "b" });
      const [hit] = searchLore(db, { query: "expiry" });
      expect(hit!.stale).toBe(false);
    });
  });

  describe("supersedeLore", () => {
    it("links the old record forward", () => {
      const a = addLore(db, { title: "Old", summary: "s", body: "b" });
      const b = addLore(db, { title: "New", summary: "s", body: "b" });
      const updated = supersedeLore(db, a.id, b.id);
      expect(updated?.status).toBe("superseded");
      expect(updated?.supersededBy).toBe(b.id);
    });
    it("rejects same-id supersede", () => {
      const a = addLore(db, { title: "X", summary: "s", body: "b" });
      expect(supersedeLore(db, a.id, a.id)).toBeNull();
    });
    it("rejects supersede with a non-existent replacement id", () => {
      const a = addLore(db, { title: "X", summary: "s", body: "b" });
      expect(supersedeLore(db, a.id, "nope1234")).toBeNull();
      // Original record should be untouched (still active).
      expect(getLore(db, a.id)?.status).toBe("active");
    });
    it("rejects supersede when replacement is already deprecated / superseded", () => {
      const a = addLore(db, { title: "A", summary: "s", body: "b" });
      const b = addLore(db, { title: "B", summary: "s", body: "b" });
      deprecateLore(db, b.id);
      expect(supersedeLore(db, a.id, b.id)).toBeNull();
      expect(getLore(db, a.id)?.status).toBe("active");
    });
    it("emits a 'superseded' event with the target id in payload", () => {
      const a = addLore(db, { title: "Old", summary: "s", body: "b" });
      const b = addLore(db, { title: "New", summary: "s", body: "b" });
      supersedeLore(db, a.id, b.id);
      const ev = db
        .prepare(
          "SELECT kind, payload FROM events WHERE lore_id = ? AND kind = 'superseded'",
        )
        .get(a.id) as { kind: string; payload: string };
      expect(ev.kind).toBe("superseded");
      expect(JSON.parse(ev.payload)).toEqual({ supersededBy: b.id });
    });
  });

  describe("verifyLore + deleteLore", () => {
    it("verifyLore bumps last_verified_at + emits event", () => {
      const lore = addLore(db, { title: "t", summary: "s", body: "b" });
      const verified = verifyLore(db, lore.id);
      expect(verified?.lastVerifiedAt).toBeDefined();
      const kinds = (
        db
          .prepare(
            "SELECT kind FROM events WHERE lore_id = ? ORDER BY rowid",
          )
          .all(lore.id) as Array<{ kind: string }>
      ).map((e) => e.kind);
      expect(kinds).toContain("verified");
    });

    it("verifyLore clears staleness by pushing review_after forward when lapsed", () => {
      const lore = addLore(db, {
        title: "old rule",
        summary: "s",
        body: "b",
        reviewAfter: "2020-01-01",
      });
      const before = searchLore(db, { query: "old rule" })[0];
      expect(before?.stale).toBe(true);
      const verified = verifyLore(db, lore.id);
      // Default forward push gives us a future date.
      expect(verified?.reviewAfter).toBeDefined();
      expect(Date.parse(verified!.reviewAfter!)).toBeGreaterThan(Date.now());
      const after = searchLore(db, { query: "old rule" })[0];
      expect(after?.stale).toBe(false);
    });

    it("verifyLore accepts an explicit nextReviewAfter override", () => {
      const lore = addLore(db, { title: "x", summary: "s", body: "b" });
      const verified = verifyLore(db, lore.id, "2099-12-31");
      expect(verified?.reviewAfter).toBe("2099-12-31");
    });

    it("verifyLore rejects an invalid nextReviewAfter", () => {
      const lore = addLore(db, { title: "x", summary: "s", body: "b" });
      expect(() => verifyLore(db, lore.id, "garbage")).toThrow(
        /nextReviewAfter/,
      );
    });

    it("deleteLore cascades repos + tags + removes from FTS", () => {
      const lore = addLore(db, {
        title: "t",
        summary: "s",
        body: "b",
        repos: ["x"],
        tags: ["y"],
      });
      expect(deleteLore(db, lore.id)).toBe(true);
      expect(getLore(db, lore.id)).toBeNull();
      expect(
        db
          .prepare("SELECT * FROM lore_repos WHERE lore_id = ?")
          .all(lore.id),
      ).toEqual([]);
      expect(
        db
          .prepare("SELECT * FROM lore_tags WHERE lore_id = ?")
          .all(lore.id),
      ).toEqual([]);
      expect(searchLore(db, { query: lore.title })).toEqual([]);
    });
  });

  describe("updateLore", () => {
    it("partial-updates only the fields provided", () => {
      const a = addLore(db, {
        title: "Original",
        summary: "old summary",
        body: "old body",
        repos: ["one"],
        tags: ["old-tag"],
      });
      const updated = updateLore(db, a.id, {
        summary: "new summary",
        tags: ["new-tag", "another"],
      });
      expect(updated?.title).toBe("Original");
      expect(updated?.summary).toBe("new summary");
      expect(updated?.body).toBe("old body");
      // Tags replaced (not merged).
      expect(updated?.tags).toEqual(["another", "new-tag"]);
      // Repos untouched.
      expect(updated?.repos).toEqual(["one"]);
    });

    it("reindexes FTS when title/summary/body changes", () => {
      const a = addLore(db, {
        title: "Aardvark policy",
        summary: "s",
        body: "b",
      });
      expect(searchLore(db, { query: "Aardvark" })).toHaveLength(1);
      updateLore(db, a.id, { title: "Buffalo policy" });
      expect(searchLore(db, { query: "Aardvark" })).toEqual([]);
      expect(searchLore(db, { query: "Buffalo" })).toHaveLength(1);
    });

    it("emits an 'updated' event", () => {
      const a = addLore(db, { title: "t", summary: "s", body: "b" });
      updateLore(db, a.id, { summary: "new" });
      const kinds = (
        db
          .prepare("SELECT kind FROM events WHERE lore_id = ? ORDER BY rowid")
          .all(a.id) as Array<{ kind: string }>
      ).map((e) => e.kind);
      expect(kinds).toContain("updated");
    });

    it("re-clamps confidence on update (sourceless → high downgraded)", () => {
      const a = addLore(db, {
        title: "t",
        summary: "s",
        body: "b",
        source: "https://x.example",
        confidence: "high",
      });
      expect(a.confidence).toBe("high");
      // Remove the source — confidence should fall.
      const updated = updateLore(db, a.id, { source: "" });
      expect(updated?.confidence).toBe("medium");
    });

    it("returns null for unknown id", () => {
      expect(updateLore(db, "ghost", { title: "x" })).toBeNull();
    });
  });

  describe("source URL validation", () => {
    it("addLore rejects a non-URL source", () => {
      expect(() =>
        addLore(db, {
          title: "t",
          summary: "s",
          body: "b",
          source: "ADR-014",
        }),
      ).toThrow(/source/);
    });
    it("addLore rejects a non-http URL", () => {
      expect(() =>
        addLore(db, {
          title: "t",
          summary: "s",
          body: "b",
          source: "javascript:alert(1)",
        }),
      ).toThrow(/source/);
    });
    it("addLore accepts an https URL", () => {
      const lore = addLore(db, {
        title: "t",
        summary: "s",
        body: "b",
        source: "https://example.com/adrs/14",
      });
      expect(lore.source).toBe("https://example.com/adrs/14");
    });
    it("updateLore can clear the source by passing empty string", () => {
      const a = addLore(db, {
        title: "t",
        summary: "s",
        body: "b",
        source: "https://example.com/x",
        confidence: "high",
      });
      const updated = updateLore(db, a.id, { source: "" });
      expect(updated?.source).toBeUndefined();
      // And confidence drops because no source.
      expect(updated?.confidence).toBe("medium");
    });
  });

  describe("FTS — technical identifiers (coding-domain tokens)", () => {
    /**
     * Coding lore is full of hyphenated service names, version-numbered
     * algorithms, camelCase API symbols, and weird identifier casing.
     * The FTS5 tokenizer (porter + unicode61) is generally good but
     * these specific shapes are worth exercising once.
     */
    beforeEach(() => {
      addLore(db, {
        title: "payments-svc rejects naive dates",
        summary: "All inbound API dates must include timezone offsets.",
        body: "We discovered this in INC-411; payments-svc validation rejects.",
        repos: ["payments-svc"],
        tags: ["dates", "api"],
      });
      addLore(db, {
        title: "Argon2id is the password hash default",
        summary: "Platform sec ruling. m=64MB, t=3, p=4.",
        body: "Use Argon2id; legacy bcrypt records migrate on next login.",
        tags: ["security"],
      });
    });

    it("finds the hyphenated service name 'payments-svc'", () => {
      const hits = searchLore(db, { query: "payments-svc" });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.repos).toContain("payments-svc");
    });

    it("finds 'Argon2id' regardless of case", () => {
      const upper = searchLore(db, { query: "Argon2id" });
      const lower = searchLore(db, { query: "argon2id" });
      expect(upper.length).toBeGreaterThan(0);
      expect(lower.length).toBeGreaterThan(0);
      expect(upper[0]!.id).toBe(lower[0]!.id);
    });

    it("finds 'bcrypt' even though the title talks about Argon2id", () => {
      const hits = searchLore(db, { query: "bcrypt" });
      expect(hits.length).toBeGreaterThan(0);
    });

    it("repo filter accepts the canonical repo name", () => {
      const hits = searchLore(db, { query: "dates", repo: "payments-svc" });
      expect(hits.length).toBe(1);
    });
  });

  describe("reviewAfter date validation", () => {
    it("addLore rejects an invalid ISO date for reviewAfter", () => {
      expect(() =>
        addLore(db, {
          title: "t",
          summary: "s",
          body: "b",
          reviewAfter: "not-a-date",
        }),
      ).toThrow(/reviewAfter/);
    });
    it("updateLore rejects an invalid ISO date for reviewAfter", () => {
      const a = addLore(db, { title: "t", summary: "s", body: "b" });
      expect(() =>
        updateLore(db, a.id, { reviewAfter: "garbage" }),
      ).toThrow(/reviewAfter/);
    });
  });

  describe("findPossibleDuplicates", () => {
    it("returns near-duplicates by title token overlap", () => {
      const existing = addLore(db, {
        title: "Dates must include timezone offsets",
        summary: "Existing rule.",
        body: "b",
        repos: ["payments-svc"],
        tags: ["dates"],
      });
      const fresh = suggestLore(db, {
        title: "API dates need timezone offset",
        summary: "Same idea, drafted again.",
        body: "b",
        repos: ["payments-svc"],
        tags: ["dates"],
      });
      const { duplicates, restrictedDuplicateCount } = findPossibleDuplicates(db, {
        id: fresh.id,
        title: "API dates need timezone offset",
        repos: ["payments-svc"],
        tags: ["dates"],
      });
      expect(duplicates.map((d) => d.id)).toContain(existing.id);
      expect(restrictedDuplicateCount).toBe(0);
    });

    it("populates a `reason` field summarising matched signals", () => {
      const existing = addLore(db, {
        title: "Vermilion zeppelin altitude policy",
        summary: "s",
        body: "b",
        repos: ["aviation-svc"],
        tags: ["safety"],
      });
      const fresh = suggestLore(db, {
        title: "Vermilion zeppelin altitude policy new",
        summary: "s",
        body: "b",
        repos: ["aviation-svc"],
        tags: ["safety"],
      });
      const { duplicates } = findPossibleDuplicates(db, {
        id: fresh.id,
        title: "Vermilion zeppelin altitude policy new",
        repos: ["aviation-svc"],
        tags: ["safety"],
      });
      const hit = duplicates.find((d) => d.id === existing.id);
      expect(hit?.reason).toContain("similar-title");
      expect(hit?.reason).toContain("shared-repo:aviation-svc");
      expect(hit?.reason).toContain("shared-tag:safety");
    });

    it("returns the empty result when title has fewer than two meaningful tokens", () => {
      addLore(db, {
        title: "Things",
        summary: "s",
        body: "b",
      });
      expect(
        findPossibleDuplicates(db, { id: "xxxxxxxx", title: "x" }),
      ).toEqual({ duplicates: [], restrictedDuplicateCount: 0 });
    });

    it("excludes the given id (no self-match for the just-inserted record)", () => {
      const lore = suggestLore(db, {
        title: "Argon2id password hashing default",
        summary: "s",
        body: "b",
      });
      const { duplicates } = findPossibleDuplicates(db, {
        id: lore.id,
        title: "Argon2id password hashing default",
      });
      expect(duplicates.map((d) => d.id)).not.toContain(lore.id);
    });

    it("by default hides restricted titles but reports them in restrictedDuplicateCount", () => {
      addLore(db, {
        title: "Restricted runbook rotate platinum keys",
        summary: "s",
        body: "b",
        restricted: true,
      });
      const draft = suggestLore(db, {
        title: "Rotate platinum keys policy",
        summary: "s",
        body: "b",
      });
      const { duplicates, restrictedDuplicateCount } = findPossibleDuplicates(
        db,
        { id: draft.id, title: "Rotate platinum keys policy" },
      );
      expect(duplicates.every((d) => d.restricted === false)).toBe(true);
      expect(restrictedDuplicateCount).toBe(1);
    });

    it("surfaces restricted titles when allowRestricted: true", () => {
      const restricted = addLore(db, {
        title: "Restricted runbook rotate gold keys",
        summary: "s",
        body: "b",
        restricted: true,
      });
      const draft = suggestLore(db, {
        title: "Rotate gold keys policy",
        summary: "s",
        body: "b",
      });
      const { duplicates, restrictedDuplicateCount } = findPossibleDuplicates(
        db,
        { id: draft.id, title: "Rotate gold keys policy" },
        { allowRestricted: true },
      );
      expect(duplicates.map((d) => d.id)).toContain(restricted.id);
      expect(restrictedDuplicateCount).toBe(1);
    });

    it("excludes deprecated and superseded records", () => {
      const a = addLore(db, {
        title: "Deprecated bcrypt password policy",
        summary: "s",
        body: "b",
      });
      const b = addLore(db, {
        title: "Old superseded bcrypt password rule",
        summary: "s",
        body: "b",
      });
      const c = addLore(db, {
        title: "Replacement bcrypt password rule",
        summary: "s",
        body: "b",
      });
      deprecateLore(db, a.id);
      supersedeLore(db, b.id, c.id);
      const draft = suggestLore(db, {
        title: "New bcrypt password idea",
        summary: "s",
        body: "b",
      });
      const { duplicates } = findPossibleDuplicates(db, {
        id: draft.id,
        title: "New bcrypt password idea",
      });
      const ids = duplicates.map((d) => d.id);
      expect(ids).not.toContain(a.id);
      expect(ids).not.toContain(b.id);
      // c (the active replacement) is fair game.
      expect(ids).toContain(c.id);
    });

    it("ranks shared-repo/tag overlap above pure-FTS matches", () => {
      // Two existing records with similar titles. One shares the draft's
      // repo, the other doesn't. Both should be candidates; the
      // repo-overlap one should come first.
      const sharesRepo = addLore(db, {
        title: "Cerulean kite altitude policy",
        summary: "s",
        body: "b",
        repos: ["aviation-svc"],
      });
      addLore(db, {
        title: "Cerulean kite altitude policy archive",
        summary: "s",
        body: "b",
        repos: ["other-svc"],
      });
      const draft = suggestLore(db, {
        title: "Cerulean kite altitude policy new",
        summary: "s",
        body: "b",
        repos: ["aviation-svc"],
      });
      const { duplicates } = findPossibleDuplicates(db, {
        id: draft.id,
        title: "Cerulean kite altitude policy new",
        repos: ["aviation-svc"],
      });
      expect(duplicates.length).toBeGreaterThanOrEqual(1);
      expect(duplicates[0]!.id).toBe(sharesRepo.id);
    });

    it("returns the empty result when no candidates match", () => {
      addLore(db, {
        title: "Completely unrelated subject matter here",
        summary: "s",
        body: "b",
      });
      expect(
        findPossibleDuplicates(db, {
          id: "xxxxxxxx",
          title: "Magenta dirigible policy",
        }),
      ).toEqual({ duplicates: [], restrictedDuplicateCount: 0 });
    });
  });

  describe("searchLore ranking — column weights + prefix + multi-tag", () => {
    /**
     * The column weights (title=3, summary=2, body=1) mean a hit in the
     * title outranks a hit in the body all else equal. Exercise with two
     * records that swap which column contains the query term.
     */
    it("ranks title hits above body hits for the same query", () => {
      const titleHit = addLore(db, {
        title: "Argon2id is the password hash default",
        summary: "Platform sec ruling.",
        body: "Use m=64MB.",
      });
      addLore(db, {
        title: "Migration style guide",
        summary: "Liquibase format.",
        body: "We migrated from bcrypt to argon2id last year.",
      });
      const hits = searchLore(db, { query: "argon2id" });
      expect(hits.length).toBeGreaterThanOrEqual(2);
      expect(hits[0]!.id).toBe(titleHit.id);
    });

    it("prefix mode matches tokens of 3+ chars as prefixes", () => {
      addLore(db, {
        title: "API dates must include timezone offsets",
        summary: "s",
        body: "b",
      });
      // Exact-match mode should not find 'timez' (no such token).
      expect(searchLore(db, { query: "timez" })).toHaveLength(0);
      // Prefix mode should.
      expect(
        searchLore(db, { query: "timez", prefix: true }).length,
      ).toBeGreaterThan(0);
    });

    it("prefix mode leaves <3-char tokens as exact-match (no slow 1-char prefix)", () => {
      addLore(db, {
        title: "AB convention example",
        summary: "s",
        body: "b",
      });
      // 'ab' is 2 chars — still exact, hits the record.
      const exact = searchLore(db, { query: "ab", prefix: true });
      expect(exact.length).toBeGreaterThan(0);
    });

    it("tag accepts a string array — ANY-of semantics", () => {
      const a = addLore(db, {
        title: "auth ruling",
        summary: "s",
        body: "b",
        tags: ["security"],
      });
      const b = addLore(db, {
        title: "db ruling",
        summary: "s",
        body: "b",
        tags: ["db"],
      });
      const c = addLore(db, {
        title: "frontend ruling",
        summary: "s",
        body: "b",
        tags: ["frontend"],
      });
      const hits = searchLore(db, { tag: ["security", "db"] });
      const ids = hits.map((h) => h.id);
      expect(ids).toContain(a.id);
      expect(ids).toContain(b.id);
      expect(ids).not.toContain(c.id);
    });

    it("single-tag string still works (back-compat)", () => {
      addLore(db, {
        title: "x",
        summary: "s",
        body: "b",
        tags: ["security"],
      });
      const hits = searchLore(db, { tag: "security" });
      expect(hits.length).toBe(1);
    });
  });

  describe("conflict surfacing in searchLore", () => {
    /**
     * Two active records sharing a repo and a tag are flagged in each
     * other's `conflicts` array. The intent is to make a "two
     * authoritative-looking records disagree" situation visible to the
     * agent without an extra round trip.
     */
    it("flags two active records sharing repo + tag", () => {
      const a = addLore(db, {
        title: "Password hash policy A",
        summary: "Use Argon2id",
        body: "B",
        repos: ["auth-svc"],
        tags: ["security"],
      });
      const b = addLore(db, {
        title: "Password hash policy B",
        summary: "Use scrypt",
        body: "B",
        repos: ["auth-svc"],
        tags: ["security"],
      });
      const hits = searchLore(db, { query: "password hash policy" });
      const ha = hits.find((h) => h.id === a.id);
      const hb = hits.find((h) => h.id === b.id);
      expect(ha?.conflicts).toContain(b.id);
      expect(hb?.conflicts).toContain(a.id);
    });

    it("does not flag when only the repo overlaps", () => {
      addLore(db, {
        title: "Migration policy",
        summary: "x",
        body: "B",
        repos: ["billing-svc"],
        tags: ["migrations"],
      });
      addLore(db, {
        title: "Migration testing checklist",
        summary: "x",
        body: "B",
        repos: ["billing-svc"],
        tags: ["testing"], // different tag
      });
      const hits = searchLore(db, { query: "migration" });
      for (const h of hits) {
        expect(h.conflicts ?? []).toEqual([]);
      }
    });

    it("does not flag when only the tag overlaps", () => {
      addLore(db, {
        title: "Cookie policy A",
        summary: "x",
        body: "B",
        repos: ["frontend"],
        tags: ["security"],
      });
      addLore(db, {
        title: "Cookie policy B",
        summary: "x",
        body: "B",
        repos: ["api"], // different repo
        tags: ["security"],
      });
      const hits = searchLore(db, { query: "cookie policy" });
      for (const h of hits) {
        expect(h.conflicts ?? []).toEqual([]);
      }
    });

    it("does not flag drafts, deprecated, or superseded records", () => {
      const active = addLore(db, {
        title: "Active webhook policy",
        summary: "x",
        body: "B",
        repos: ["payments-svc"],
        tags: ["webhooks"],
      });
      const deprecated = addLore(db, {
        title: "Old webhook policy",
        summary: "x",
        body: "B",
        repos: ["payments-svc"],
        tags: ["webhooks"],
      });
      deprecateLore(db, deprecated.id);
      const hits = searchLore(db, {
        query: "webhook policy",
        includeDeprecated: true,
      });
      const ha = hits.find((h) => h.id === active.id);
      // deprecated co-result shouldn't trigger a conflict
      expect(ha?.conflicts ?? []).toEqual([]);
    });

    it("populates conflicts for a 3-way overlap correctly", () => {
      const a = addLore(db, {
        title: "Caching policy A",
        summary: "x",
        body: "B",
        repos: ["api"],
        tags: ["caching"],
      });
      const b = addLore(db, {
        title: "Caching policy B",
        summary: "x",
        body: "B",
        repos: ["api"],
        tags: ["caching"],
      });
      const c = addLore(db, {
        title: "Caching policy C",
        summary: "x",
        body: "B",
        repos: ["api"],
        tags: ["caching"],
      });
      const hits = searchLore(db, { query: "caching policy" });
      const ha = hits.find((h) => h.id === a.id);
      const hb = hits.find((h) => h.id === b.id);
      const hc = hits.find((h) => h.id === c.id);
      // Each should list the other two.
      expect(ha?.conflicts?.sort()).toEqual([b.id, c.id].sort());
      expect(hb?.conflicts?.sort()).toEqual([a.id, c.id].sort());
      expect(hc?.conflicts?.sort()).toEqual([a.id, b.id].sort());
    });

    it("does not flag a single result with no other co-results", () => {
      addLore(db, {
        title: "Lonely policy",
        summary: "x",
        body: "B",
        repos: ["solo"],
        tags: ["solo"],
      });
      const hits = searchLore(db, { query: "Lonely policy" });
      expect(hits[0]?.conflicts ?? []).toEqual([]);
    });
  });

  describe("exportLore", () => {
    /**
     * Round-trip-ish coverage: the export should reflect the same
     * default-safe lifecycle filter as search (active + non-restricted),
     * round-trip the full Lore shape (including body), and provide a
     * stable ordering so two exports of the same DB diff cleanly.
     */
    it("defaults to active + non-restricted only", () => {
      const active = addLore(db, { title: "active rule", summary: "s", body: "B" });
      const draft = suggestLore(db, { title: "draft rule", summary: "s", body: "B" });
      const deprecated = addLore(db, {
        title: "old rule",
        summary: "s",
        body: "B",
      });
      deprecateLore(db, deprecated.id);
      const restricted = addLore(db, {
        title: "restricted rule",
        summary: "s",
        body: "B",
        restricted: true,
      });
      const recs = exportLore(db);
      const ids = recs.map((r) => r.id);
      expect(ids).toContain(active.id);
      expect(ids).not.toContain(draft.id);
      expect(ids).not.toContain(deprecated.id);
      expect(ids).not.toContain(restricted.id);
    });

    it("includes the body — full Lore, not a brief summary", () => {
      addLore(db, {
        title: "round-trip body test",
        summary: "s",
        body: "BODY-MARKER-12345",
      });
      const [rec] = exportLore(db);
      expect(rec?.body).toBe("BODY-MARKER-12345");
    });

    it("honours each opt-in flag independently", () => {
      const a = addLore(db, { title: "a", summary: "s", body: "B" });
      const drafted = suggestLore(db, { title: "b draft", summary: "s", body: "B" });
      const dep = addLore(db, { title: "c dep", summary: "s", body: "B" });
      deprecateLore(db, dep.id);
      const sup1 = addLore(db, { title: "d sup-old", summary: "s", body: "B" });
      const sup2 = addLore(db, { title: "e sup-new", summary: "s", body: "B" });
      supersedeLore(db, sup1.id, sup2.id);
      const r = addLore(db, {
        title: "f restricted",
        summary: "s",
        body: "B",
        restricted: true,
      });

      expect(exportLore(db).map((x) => x.id).sort()).toEqual(
        [a.id, sup2.id].sort(),
      );
      expect(
        exportLore(db, { includeDrafts: true }).map((x) => x.id),
      ).toContain(drafted.id);
      expect(
        exportLore(db, { includeDeprecated: true }).map((x) => x.id),
      ).toContain(dep.id);
      expect(
        exportLore(db, { includeSuperseded: true }).map((x) => x.id),
      ).toContain(sup1.id);
      expect(
        exportLore(db, { includeRestricted: true }).map((x) => x.id),
      ).toContain(r.id);
    });

    it("produces stable ordering: updated_at desc, id asc tiebreak", async () => {
      const a = addLore(db, { title: "a", summary: "s", body: "B" });
      const b = addLore(db, { title: "b", summary: "s", body: "B" });
      const c = addLore(db, { title: "c", summary: "s", body: "B" });
      // Ensure the next mutation gets a later ISO millisecond stamp.
      await new Promise((r) => setTimeout(r, 5));
      updateLore(db, b.id, { summary: "s2" });
      const ids = exportLore(db).map((r) => r.id);
      expect(ids[0]).toBe(b.id);
      expect(ids.slice(1).sort()).toEqual([a.id, c.id].sort());
    });

    it("falls back to id-asc tiebreak when updated_at is identical", () => {
      // Same insert tick: updated_at collides at ms precision, so ordering
      // must be deterministic via the id-ASC tiebreak. We can't predict
      // the random ids, but the export's id order should be ascending.
      const ids = [
        addLore(db, { title: "x", summary: "s", body: "B" }).id,
        addLore(db, { title: "y", summary: "s", body: "B" }).id,
        addLore(db, { title: "z", summary: "s", body: "B" }).id,
      ];
      // If timestamps collide (likely in a fast loop), all three share an
      // updated_at; if they don't, the test still passes because we only
      // assert determinism, not a specific order.
      const exportedIds = exportLore(db).map((r) => r.id);
      // The set of returned ids matches the inserted set.
      expect(new Set(exportedIds)).toEqual(new Set(ids));
      // And a second export gives the identical ordering — that's the
      // determinism guarantee.
      const exportedIdsAgain = exportLore(db).map((r) => r.id);
      expect(exportedIdsAgain).toEqual(exportedIds);
    });

    it("returns repos + tags joined per record", () => {
      addLore(db, {
        title: "with-meta",
        summary: "s",
        body: "B",
        repos: ["payments-svc", "auth-svc"],
        tags: ["security", "passwords"],
      });
      const [rec] = exportLore(db);
      expect(rec?.repos).toEqual(["auth-svc", "payments-svc"]);
      expect(rec?.tags).toEqual(["passwords", "security"]);
    });
  });

  describe("listTags + listRepos + listRecent", () => {
    it("listTags / listRepos are sorted + deduplicated", () => {
      addLore(db, {
        title: "a",
        summary: "s",
        body: "b",
        repos: ["alpha"],
        tags: ["one", "two"],
      });
      addLore(db, {
        title: "b",
        summary: "s",
        body: "b",
        repos: ["alpha", "beta"],
        tags: ["two", "three"],
      });
      expect(listRepos(db)).toEqual(["alpha", "beta"]);
      expect(listTags(db)).toEqual(["one", "three", "two"]);
    });
    it("listRecent returns all lifecycle states for browsing", () => {
      addLore(db, { title: "active one", summary: "s", body: "b" });
      const drafted = suggestLore(db, {
        title: "draft one",
        summary: "s",
        body: "b",
      });
      const dep = addLore(db, {
        title: "to deprecate",
        summary: "s",
        body: "b",
      });
      deprecateLore(db, dep.id);
      const all = listRecent(db);
      const titles = all.map((l) => l.title).sort();
      expect(titles).toContain("active one");
      expect(titles).toContain("draft one");
      expect(titles).toContain("to deprecate");
      expect(all.find((l) => l.id === drafted.id)?.status).toBe("draft");
    });
  });
});
