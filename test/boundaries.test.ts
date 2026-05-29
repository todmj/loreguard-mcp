/**
 * Boundaries — the cross-repo interaction map. Pins:
 *   - migration 004 adds the table
 *   - normaliseContract joins camelCase / kebab / snake / spaced spellings
 *   - declare (add=active / suggest=draft), the draft trust gate, upsert
 *     on the (repo, contract, role) key
 *   - findDependents splits providers vs consumers (the impact query)
 *   - approve / reject / deprecate lifecycle
 *   - export/import round-trip converges two repos' edges on one row
 */
import BetterSqlite3 from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  addBoundary,
  approveBoundary,
  deprecateBoundary,
  exportBoundaries,
  findDependents,
  importBoundary,
  listBoundaries,
  listBoundaryDrafts,
  listContracts,
  normaliseContract,
  rejectBoundary,
  suggestBoundary,
} from "../src/core/boundaries.js";
import { runMigrations } from "../src/db/migrations.js";
import type { Database } from "better-sqlite3";

function newDb(): Database {
  const db = new BetterSqlite3(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

describe("normaliseContract", () => {
  it("converges camelCase, PascalCase, kebab, snake, and spaced spellings", () => {
    const want = "order-submitted";
    expect(normaliseContract("OrderSubmitted")).toBe(want);
    expect(normaliseContract("orderSubmitted")).toBe(want);
    expect(normaliseContract("order-submitted")).toBe(want);
    expect(normaliseContract("order_submitted")).toBe(want);
    expect(normaliseContract("  Order Submitted  ")).toBe(want);
  });

  it("handles acronym runs (HTTPServer → http-server)", () => {
    expect(normaliseContract("HTTPServer")).toBe("http-server");
  });

  it("preserves path-like and dotted contract names", () => {
    expect(normaliseContract("POST /v1/orders")).toBe("post-/v1/orders");
    expect(normaliseContract("orders.submitted")).toBe("orders.submitted");
  });
});

describe("declareBoundary (add / suggest) + trust gate", () => {
  let db: Database;
  beforeEach(() => {
    db = newDb();
  });

  it("addBoundary lands active and visible; suggestBoundary lands draft and hidden", () => {
    const active = addBoundary(db, {
      repo: "orders-svc",
      contract: "OrderSubmitted",
      role: "provides",
    });
    expect(active.status).toBe("active");
    expect(active.contract).toBe("order-submitted");

    const draft = suggestBoundary(db, {
      repo: "reporting-svc",
      contract: "order-submitted",
      role: "consumes",
    });
    expect(draft.status).toBe("draft");

    // Default map shows only the active edge.
    const visible = listBoundaries(db);
    expect(visible.map((b) => b.id)).toEqual([active.id]);
    // Draft surfaces only with includeDrafts.
    expect(
      listBoundaries(db, { includeDrafts: true }).map((b) => b.id).sort(),
    ).toEqual([active.id, draft.id].sort());
  });

  it("re-declaring the same (repo, contract, role) upserts in place, not duplicates", () => {
    const a = addBoundary(db, {
      repo: "orders-svc",
      contract: "order-submitted",
      role: "provides",
      detail: "v1",
    });
    const b = addBoundary(db, {
      repo: "orders-svc",
      contract: "OrderSubmitted", // different spelling, same normalised key
      role: "provides",
      detail: "v2",
    });
    expect(b.id).toBe(a.id);
    expect(b.detail).toBe("v2");
    expect(listBoundaries(db)).toHaveLength(1);
  });

  it("a human re-declaring an agent's draft edge promotes it to active", () => {
    const draft = suggestBoundary(db, {
      repo: "svc",
      contract: "c",
      role: "consumes",
    });
    expect(draft.status).toBe("draft");
    const promoted = addBoundary(db, {
      repo: "svc",
      contract: "c",
      role: "consumes",
    });
    expect(promoted.id).toBe(draft.id);
    expect(promoted.status).toBe("active");
  });

  it("an agent re-declaring an active edge never demotes it", () => {
    const active = addBoundary(db, { repo: "svc", contract: "c", role: "provides" });
    const again = suggestBoundary(db, { repo: "svc", contract: "c", role: "provides" });
    expect(again.id).toBe(active.id);
    expect(again.status).toBe("active");
  });

  it("rejects an unknown role and empty repo/contract", () => {
    expect(() =>
      addBoundary(db, { repo: "svc", contract: "c", role: "uses" as never }),
    ).toThrow(/role/);
    expect(() =>
      addBoundary(db, { repo: "", contract: "c", role: "provides" }),
    ).toThrow(/repo/);
    expect(() =>
      addBoundary(db, { repo: "svc", contract: "  ", role: "provides" }),
    ).toThrow(/contract/);
  });
});

describe("findDependents (the impact query)", () => {
  let db: Database;
  beforeEach(() => {
    db = newDb();
    addBoundary(db, { repo: "orders-svc", contract: "OrderSubmitted", role: "provides" });
    addBoundary(db, { repo: "reporting-svc", contract: "order-submitted", role: "consumes" });
    addBoundary(db, { repo: "billing-svc", contract: "order_submitted", role: "consumes" });
  });

  it("splits providers from consumers regardless of contract spelling", () => {
    const r = findDependents(db, "Order Submitted");
    expect(r.contract).toBe("order-submitted");
    expect(r.providers.map((b) => b.repo)).toEqual(["orders-svc"]);
    expect(r.consumers.map((b) => b.repo).sort()).toEqual([
      "billing-svc",
      "reporting-svc",
    ]);
  });

  it("excludes draft edges by default; includes with includeDrafts", () => {
    suggestBoundary(db, { repo: "analytics-svc", contract: "order-submitted", role: "consumes" });
    expect(findDependents(db, "order-submitted").consumers).toHaveLength(2);
    expect(
      findDependents(db, "order-submitted", { includeDrafts: true }).consumers,
    ).toHaveLength(3);
  });

  it("returns empty arrays for an unknown contract", () => {
    const r = findDependents(db, "never-declared");
    expect(r.providers).toEqual([]);
    expect(r.consumers).toEqual([]);
  });

  it("listContracts returns distinct normalised names", () => {
    expect(listContracts(db)).toEqual(["order-submitted"]);
  });
});

describe("boundary lifecycle (approve / reject / deprecate)", () => {
  let db: Database;
  beforeEach(() => {
    db = newDb();
  });

  it("approve promotes a draft; reject drops a draft; both refuse non-drafts", () => {
    const draft = suggestBoundary(db, { repo: "svc", contract: "c", role: "provides" });
    expect(listBoundaryDrafts(db)).toHaveLength(1);
    const approved = approveBoundary(db, draft.id);
    expect(approved?.status).toBe("active");
    // Re-approving an active edge is a no-op (null).
    expect(approveBoundary(db, draft.id)).toBeNull();
    // Reject refuses an active edge.
    expect(rejectBoundary(db, draft.id)).toBe(false);

    const draft2 = suggestBoundary(db, { repo: "svc2", contract: "c2", role: "consumes" });
    expect(rejectBoundary(db, draft2.id)).toBe(true);
    expect(listBoundaries(db, { includeDrafts: true }).map((b) => b.id)).toEqual([
      draft.id,
    ]);
  });

  it("deprecate retires an edge — hidden from default, visible with flag", () => {
    const edge = addBoundary(db, { repo: "svc", contract: "c", role: "provides" });
    expect(deprecateBoundary(db, edge.id)?.status).toBe("deprecated");
    expect(listBoundaries(db)).toHaveLength(0);
    expect(
      listBoundaries(db, { includeDeprecated: true }).map((b) => b.id),
    ).toEqual([edge.id]);
  });
});

describe("export / import round-trip (cross-repo convergence)", () => {
  it("two repos' edges for one contract converge on a single local row, keyed by (repo, contract, role)", () => {
    const orders = newDb();
    addBoundary(orders, {
      repo: "orders-svc",
      contract: "OrderSubmitted",
      role: "provides",
      detail: "v2",
    });

    const reporting = newDb();
    addBoundary(reporting, {
      repo: "reporting-svc",
      contract: "order-submitted",
      role: "consumes",
    });

    const central = newDb();
    for (const rec of exportBoundaries(orders)) importBoundary(central, rec);
    for (const rec of exportBoundaries(reporting)) importBoundary(central, rec);

    const r = findDependents(central, "order-submitted");
    expect(r.providers.map((b) => b.repo)).toEqual(["orders-svc"]);
    expect(r.consumers.map((b) => b.repo)).toEqual(["reporting-svc"]);
    // Re-importing the same edge updates in place — no duplicate row.
    for (const rec of exportBoundaries(orders)) importBoundary(central, rec);
    expect(listBoundaries(central)).toHaveLength(2);
  });

  it("importBoundary is safe (keeps a strictly-newer local edge unless force)", () => {
    const central = newDb();
    const local = addBoundary(central, {
      repo: "svc",
      contract: "c",
      role: "provides",
      detail: "local-newer",
    });
    // Incoming record with an older updatedAt.
    const stale = {
      id: local.id,
      repo: "svc",
      contract: "c",
      role: "provides" as const,
      status: "active" as const,
      detail: "incoming-older",
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
    };
    expect(importBoundary(central, stale)).toBe("skipped");
    expect(findDependents(central, "c").providers[0]!.detail).toBe("local-newer");
    // force overrides.
    expect(importBoundary(central, stale, { force: true })).toBe("updated");
    expect(findDependents(central, "c").providers[0]!.detail).toBe(
      "incoming-older",
    );
  });

  it("importBoundary skips malformed records", () => {
    const db = newDb();
    expect(
      importBoundary(db, {
        id: "",
        repo: "",
        contract: "c",
        role: "provides",
        status: "active",
        createdAt: "",
        updatedAt: "",
      }),
    ).toBe("skipped");
  });
});
