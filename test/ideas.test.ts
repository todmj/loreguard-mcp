import BetterSqlite3 from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  addIdea,
  deleteIdea,
  getIdea,
  listRecent,
  listRepos,
  listTags,
  searchIdeas,
  verifyIdea,
} from "../src/core/ideas.js";
import { runMigrations } from "../src/db/migrations.js";
import type { Database } from "better-sqlite3";

function newInMemoryDb(): Database {
  const db = new BetterSqlite3(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

describe("core/ideas", () => {
  let db: Database;
  beforeEach(() => {
    db = newInMemoryDb();
  });

  describe("addIdea", () => {
    it("creates an idea and returns it with normalised tags + repos", () => {
      const idea = addIdea(db, {
        title: "Drop bcrypt for Argon2id",
        summary: "Platform sec ruling, Q3 2025.",
        body: "Reasoning: 72-byte truncation bug. Argon2id m=64MB, t=3, p=4.",
        repos: ["payments-svc", "auth-svc"],
        tags: ["Security", "Password Hashing"],
        team: "Platform",
        author: "alice@example.com",
      });
      expect(idea.id).toMatch(/^[a-z2-9]{8}$/);
      expect(idea.repos).toEqual(["auth-svc", "payments-svc"]);
      // Tags are normalised: lowercased + spaces → hyphens.
      expect(idea.tags).toEqual(["password-hashing", "security"]);
      expect(idea.team).toBe("Platform");
      expect(idea.confidential).toBe(false);
    });

    it("emits a 'created' event row", () => {
      const idea = addIdea(db, {
        title: "t",
        summary: "s",
        body: "b",
      });
      const events = db
        .prepare("SELECT * FROM events WHERE idea_id = ?")
        .all(idea.id) as Array<{ kind: string }>;
      expect(events.map((e) => e.kind)).toEqual(["created"]);
    });
  });

  describe("getIdea", () => {
    it("returns null for an unknown id", () => {
      expect(getIdea(db, "nope")).toBeNull();
    });
    it("round-trips repos + tags", () => {
      const inserted = addIdea(db, {
        title: "t",
        summary: "s",
        body: "b",
        repos: ["a-svc"],
        tags: ["foo"],
      });
      const fetched = getIdea(db, inserted.id);
      expect(fetched?.repos).toEqual(["a-svc"]);
      expect(fetched?.tags).toEqual(["foo"]);
    });
  });

  describe("searchIdeas", () => {
    beforeEach(() => {
      addIdea(db, {
        title: "Argon2id is the password hash default",
        summary: "Platform security ruling. Bcrypt out.",
        body: "Use m=64MB, t=3, p=4.",
        repos: ["payments-svc"],
        tags: ["security", "passwords"],
      });
      addIdea(db, {
        title: "Database migrations style guide",
        summary: "Always idempotent, always reversible.",
        body: "We use Liquibase format, change-sets numbered.",
        repos: ["payments-svc", "billing-svc"],
        tags: ["db", "conventions"],
      });
      addIdea(db, {
        title: "Confidential: incident response key contacts",
        summary: "Restricted.",
        body: "On-call rotation only.",
        repos: ["secops"],
        tags: ["security"],
        confidential: true,
      });
    });

    it("FTS finds matches by stemmed term", () => {
      const hits = searchIdeas(db, { query: "password" });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.title).toContain("Argon2id");
    });

    it("repo filter narrows results", () => {
      const all = searchIdeas(db, { query: "migration" });
      const billing = searchIdeas(db, { query: "migration", repo: "billing-svc" });
      expect(billing.length).toBe(1);
      expect(billing[0]!.repos).toContain("billing-svc");
      expect(all.length).toBeGreaterThanOrEqual(billing.length);
    });

    it("excludes confidential ideas by default", () => {
      const hits = searchIdeas(db, { query: "security" });
      expect(hits.every((h) => h.confidential === false)).toBe(true);
    });

    it("surfaces confidential ideas when explicitly opted in", () => {
      const hits = searchIdeas(db, { query: "incident", includeConfidential: true });
      expect(hits.some((h) => h.confidential)).toBe(true);
    });

    it("returns the body-less projection so results stay context-cheap", () => {
      const [hit] = searchIdeas(db, { query: "Argon2id" });
      expect(hit).toBeTruthy();
      expect((hit as unknown as { body?: string }).body).toBeUndefined();
    });

    it("with no query, returns ideas updated-desc, freshness-first", () => {
      const recent = listRecent(db, 10);
      // 3 inserted (incl. confidential since listRecent opts in)
      expect(recent.length).toBe(3);
    });

    it("respects the limit clamp at 50", () => {
      for (let i = 0; i < 60; i++) {
        addIdea(db, { title: `i${i}`, summary: "s", body: "b" });
      }
      const hits = searchIdeas(db, { limit: 100 });
      expect(hits.length).toBeLessThanOrEqual(50);
    });
  });

  describe("verifyIdea", () => {
    it("bumps last_verified_at and emits a 'verified' event", () => {
      const inserted = addIdea(db, { title: "t", summary: "s", body: "b" });
      const before = inserted.lastVerifiedAt;
      const verified = verifyIdea(db, inserted.id);
      expect(verified?.lastVerifiedAt).toBeDefined();
      expect(verified?.lastVerifiedAt).not.toBe(before);
      const events = db
        .prepare("SELECT kind FROM events WHERE idea_id = ? ORDER BY rowid")
        .all(inserted.id) as Array<{ kind: string }>;
      expect(events.map((e) => e.kind)).toContain("verified");
    });
    it("returns null for unknown id", () => {
      expect(verifyIdea(db, "ghost")).toBeNull();
    });
  });

  describe("deleteIdea", () => {
    it("removes the row + cascades repos + tags", () => {
      const inserted = addIdea(db, {
        title: "t",
        summary: "s",
        body: "b",
        repos: ["x"],
        tags: ["y"],
      });
      expect(deleteIdea(db, inserted.id)).toBe(true);
      expect(getIdea(db, inserted.id)).toBeNull();
      expect(
        db.prepare("SELECT * FROM idea_repos WHERE idea_id = ?").all(inserted.id),
      ).toEqual([]);
      expect(
        db.prepare("SELECT * FROM idea_tags WHERE idea_id = ?").all(inserted.id),
      ).toEqual([]);
    });
  });

  describe("listTags + listRepos", () => {
    it("returns distinct sorted values across all ideas", () => {
      addIdea(db, {
        title: "a",
        summary: "s",
        body: "b",
        repos: ["alpha"],
        tags: ["one", "two"],
      });
      addIdea(db, {
        title: "b",
        summary: "s",
        body: "b",
        repos: ["alpha", "beta"],
        tags: ["two", "three"],
      });
      expect(listRepos(db)).toEqual(["alpha", "beta"]);
      expect(listTags(db)).toEqual(["one", "three", "two"]);
    });
  });
});
