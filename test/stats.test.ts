/**
 * `loreguard stats` — local read-tracking aggregations. Pins:
 *   - searchLore + getLore emit exactly one 'read' event per hit / per fetch
 *   - LOREGUARD_NO_TELEMETRY=1 silences both paths
 *   - LOREGUARD_AUDIT_OFF=1 silences both paths (reuses the existing gate)
 *   - topCitedRecords ranks by read count; retireCandidates surfaces
 *     active records with no reads in N days; recentActivity bins by
 *     event kind.
 */
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  addLore,
  getLore,
  searchLore,
  suggestLore,
} from "../src/core/lore.js";
import {
  recentActivity,
  retireCandidates,
  topCitedRecords,
} from "../src/cli/stats.js";
import { runMigrations } from "../src/db/migrations.js";
import type { Database } from "better-sqlite3";

function newDb(): Database {
  const db = new BetterSqlite3(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function readEventCount(db: Database, id?: string): number {
  if (id) {
    return (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM events WHERE kind = 'read' AND lore_id = ?",
        )
        .get(id) as { n: number }
    ).n;
  }
  return (
    db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'read'").get() as {
      n: number;
    }
  ).n;
}

describe("read-tracking gates", () => {
  let db: Database;
  beforeEach(() => {
    db = newDb();
    delete process.env["LOREGUARD_NO_TELEMETRY"];
    delete process.env["LOREGUARD_AUDIT_OFF"];
  });
  afterEach(() => {
    delete process.env["LOREGUARD_NO_TELEMETRY"];
    delete process.env["LOREGUARD_AUDIT_OFF"];
  });

  it("searchLore emits one 'read' event per returned hit", () => {
    const a = addLore(db, {
      title: "argon2id pwd hash",
      summary: "s",
      body: "b",
    });
    const b = addLore(db, {
      title: "argon2id reference impl",
      summary: "s",
      body: "b",
    });
    searchLore(db, { query: "argon2id" });
    expect(readEventCount(db, a.id)).toBe(1);
    expect(readEventCount(db, b.id)).toBe(1);
  });

  it("getLore emits exactly one 'read' event for the fetched record", () => {
    const a = addLore(db, { title: "x", summary: "s", body: "b" });
    getLore(db, a.id);
    expect(readEventCount(db, a.id)).toBe(1);
  });

  it("getLore on an unknown id emits no read event", () => {
    expect(getLore(db, "zzzzzzzz")).toBeNull();
    expect(readEventCount(db)).toBe(0);
  });

  it("LOREGUARD_NO_TELEMETRY=1 silences searchLore + getLore reads", () => {
    process.env["LOREGUARD_NO_TELEMETRY"] = "1";
    const a = addLore(db, {
      title: "argon",
      summary: "s",
      body: "b",
    });
    searchLore(db, { query: "argon" });
    getLore(db, a.id);
    expect(readEventCount(db)).toBe(0);
  });

  it("LOREGUARD_AUDIT_OFF=1 silences searchLore + getLore reads", () => {
    process.env["LOREGUARD_AUDIT_OFF"] = "1";
    const a = addLore(db, {
      title: "argon",
      summary: "s",
      body: "b",
    });
    searchLore(db, { query: "argon" });
    getLore(db, a.id);
    expect(readEventCount(db)).toBe(0);
  });
});

describe("topCitedRecords", () => {
  let db: Database;
  beforeEach(() => {
    db = newDb();
    delete process.env["LOREGUARD_NO_TELEMETRY"];
    delete process.env["LOREGUARD_AUDIT_OFF"];
  });

  it("ranks by read count desc; ties broken by updated_at desc", () => {
    const a = addLore(db, { title: "a-record", summary: "s", body: "b" });
    const b = addLore(db, { title: "b-record", summary: "s", body: "b" });
    const c = addLore(db, { title: "c-record", summary: "s", body: "b" });
    // a → 1, b → 3, c → 2
    getLore(db, a.id);
    getLore(db, b.id);
    getLore(db, b.id);
    getLore(db, b.id);
    getLore(db, c.id);
    getLore(db, c.id);
    const top = topCitedRecords(db, { sinceDays: 7, limit: 10 });
    expect(top.map((r) => r.id)).toEqual([b.id, c.id, a.id]);
    expect(top[0]!.readCount).toBe(3);
    expect(top[2]!.readCount).toBe(1);
  });

  it("respects sinceDays — events outside the window are excluded", () => {
    const a = addLore(db, { title: "old", summary: "s", body: "b" });
    getLore(db, a.id);
    // Backdate the read event to 100 days ago.
    db.prepare(
      "UPDATE events SET ts = ? WHERE lore_id = ? AND kind = 'read'",
    ).run(new Date(Date.now() - 100 * 86400_000).toISOString(), a.id);
    expect(topCitedRecords(db, { sinceDays: 30 })).toEqual([]);
    expect(topCitedRecords(db, { sinceDays: 365 })).toHaveLength(1);
  });

  it("excludes records that have been hard-deleted (events orphaned)", () => {
    const a = addLore(db, { title: "ghost", summary: "s", body: "b" });
    getLore(db, a.id);
    db.prepare("DELETE FROM lore WHERE id = ?").run(a.id);
    expect(topCitedRecords(db)).toEqual([]);
  });
});

describe("retireCandidates", () => {
  let db: Database;
  beforeEach(() => {
    db = newDb();
    delete process.env["LOREGUARD_NO_TELEMETRY"];
    delete process.env["LOREGUARD_AUDIT_OFF"];
  });

  it("surfaces active records with no reads in the window", () => {
    const stale = addLore(db, {
      title: "neglected",
      summary: "s",
      body: "b",
    });
    const fresh = addLore(db, {
      title: "popular",
      summary: "s",
      body: "b",
    });
    getLore(db, fresh.id); // gives fresh a recent read
    const candidates = retireCandidates(db, { quietForDays: 30 });
    expect(candidates.map((c) => c.id)).toContain(stale.id);
    expect(candidates.map((c) => c.id)).not.toContain(fresh.id);
  });

  it("excludes non-active records (draft / deprecated / superseded)", () => {
    suggestLore(db, { title: "draft", summary: "s", body: "b" });
    const candidates = retireCandidates(db, { quietForDays: 30 });
    expect(candidates).toEqual([]);
  });

  it("sorts no-source/low-confidence first as the cheapest-to-retire", () => {
    addLore(db, {
      title: "anchored-hi",
      summary: "s",
      body: "b",
      source: "https://example.com/adrs/1",
      confidence: "high",
    });
    addLore(db, {
      title: "no-source-medium",
      summary: "s",
      body: "b",
    });
    addLore(db, {
      title: "no-source-low",
      summary: "s",
      body: "b",
      confidence: "low",
    });
    const sorted = retireCandidates(db, { quietForDays: 30 });
    // First two are no-source; the "low" one comes before "medium"
    // because cheaper to retire.
    expect(sorted[0]!.hasSource).toBe(false);
    expect(sorted[0]!.confidence).toBe("low");
    expect(sorted[1]!.hasSource).toBe(false);
    expect(sorted[2]!.hasSource).toBe(true);
  });
});

describe("recentActivity", () => {
  let db: Database;
  beforeEach(() => {
    db = newDb();
    delete process.env["LOREGUARD_NO_TELEMETRY"];
    delete process.env["LOREGUARD_AUDIT_OFF"];
  });

  it("bins events by kind in the window", () => {
    const a = addLore(db, { title: "a", summary: "s", body: "b" });
    suggestLore(db, { title: "d", summary: "s", body: "b" });
    getLore(db, a.id);
    const act = recentActivity(db, { days: 1 });
    expect(act.suggested).toBe(1);
    expect(act.reads).toBe(1);
    // 'created' is not in the known-kind set on purpose — it's not
    // surfaced in the stats view (addLore emits 'created'; the view
    // shows the lifecycle verbs the team cares about). Spot-check
    // the rest are zero.
    expect(act.approved).toBe(0);
    expect(act.rejected).toBe(0);
    expect(act.deprecated).toBe(0);
    expect(act.superseded).toBe(0);
    expect(act.updated).toBe(0);
    expect(act.imports).toBe(0);
  });
});
