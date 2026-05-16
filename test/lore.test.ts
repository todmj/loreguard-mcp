import BetterSqlite3 from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  addLore,
  approveLore,
  deleteLore,
  deprecateLore,
  getLore,
  listDrafts,
  listRecent,
  listRepos,
  listTags,
  searchLore,
  supersedeLore,
  suggestLore,
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
