/**
 * Connection-level guarantees from openDb. The important one is
 * busy_timeout: loreguard's premise is multiple agents + the CLI sharing
 * one DB, and without a busy timeout a concurrent writer gets SQLITE_BUSY
 * straight back. Pin the pragma so a refactor can't silently drop it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb } from "../src/db/index.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loreguard-db-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("openDb connection pragmas", () => {
  it("sets a non-zero busy_timeout so concurrent writers wait instead of failing", () => {
    const db = openDb(join(dir, "lore.db"));
    const timeout = db.pragma("busy_timeout", { simple: true });
    expect(timeout).toBe(5000);
    db.close();
  });

  it("enables WAL journal mode", () => {
    const db = openDb(join(dir, "lore.db"));
    const mode = db.pragma("journal_mode", { simple: true });
    expect(String(mode).toLowerCase()).toBe("wal");
    db.close();
  });

  it("enforces foreign keys", () => {
    const db = openDb(join(dir, "lore.db"));
    const fk = db.pragma("foreign_keys", { simple: true });
    expect(fk).toBe(1);
    db.close();
  });
});
