import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import BetterSqlite3, { type Database } from "better-sqlite3";

import { runMigrations } from "./migrations.js";

/**
 * Default DB location. Override with `LOREGUARD_DB` for tests or alternate
 * profiles (e.g. team-shared DB on a synced volume).
 */
export function defaultDbPath(): string {
  if (process.env["LOREGUARD_DB"]) return process.env["LOREGUARD_DB"];
  return join(homedir(), ".loreguard", "lore.db");
}

/**
 * Open (or create) the lore SQLite database and run any pending migrations.
 * - DB file is created with mode 0600 (owner read/write only).
 * - Parent dir is created if missing.
 * - WAL mode is enabled so concurrent reads don't block the CLI while the
 *   MCP server is running.
 */
export function openDb(path: string = defaultDbPath()): Database {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const fresh = !existsSync(path);
  const db = new BetterSqlite3(path);
  if (fresh) {
    try {
      chmodSync(path, 0o600);
    } catch {
      // chmod is a best-effort lockdown on platforms that support it.
    }
  }
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  runMigrations(db);
  return db;
}
