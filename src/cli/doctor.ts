import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { openDb, defaultDbPath } from "../db/index.js";

interface Check {
  readonly label: string;
  /** 'ok' | 'warn' | 'fail' — warn doesn't exit non-zero, fail does. */
  readonly level: "ok" | "warn" | "fail";
  readonly detail?: string;
  readonly fix?: string;
}

function auditPath(): string {
  return (
    process.env["LOREGUARD_AUDIT_LOG"] ?? join(homedir(), ".loreguard", "audit.jsonl")
  );
}

function checkFileMode(path: string, required: number): Check["level"] {
  try {
    const mode = statSync(path).mode & 0o777;
    if ((mode & ~required) !== 0) return "warn";
    return "ok";
  } catch {
    return "warn";
  }
}

function pkgVersion(): string {
  // Static for v0.1; reads from a bundled JSON in a later release.
  return "0.1.0";
}

export function runDoctor(): { exitCode: number; checks: Check[] } {
  const dbPath = defaultDbPath();
  const dbDir = dirname(dbPath);
  const auditPathStr = auditPath();
  const checks: Check[] = [];

  // 1. DB file exists.
  if (existsSync(dbPath)) {
    checks.push({ label: `DB exists: ${dbPath}`, level: "ok" });
  } else {
    checks.push({
      label: `DB missing: ${dbPath}`,
      level: "warn",
      fix: "Run `loreguard init` to create it.",
    });
  }

  // 2. DB file mode 0600 (warn if loose).
  if (existsSync(dbPath)) {
    const mode = statSync(dbPath).mode & 0o777;
    if (mode === 0o600) {
      checks.push({
        label: "DB permissions: 0600",
        level: "ok",
      });
    } else {
      checks.push({
        label: `DB permissions: ${mode.toString(8).padStart(4, "0")}`,
        level: "warn",
        detail: "Recommended 0600 (owner read/write only).",
        fix: `chmod 600 ${dbPath}`,
      });
    }
  }

  // 3. Parent dir mode 0700 (warn if loose).
  if (existsSync(dbDir)) {
    const mode = statSync(dbDir).mode & 0o777;
    if (mode === 0o700) {
      checks.push({ label: `DB dir permissions: 0700`, level: "ok" });
    } else {
      checks.push({
        label: `DB dir permissions: ${mode.toString(8).padStart(4, "0")}`,
        level: "warn",
        detail: "Recommended 0700.",
        fix: `chmod 700 ${dbDir}`,
      });
    }
  }

  // 4. Open DB + verify schema (FTS table reachable).
  try {
    const db = openDb(dbPath);
    try {
      const fts = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='lore_fts'",
        )
        .get();
      if (fts) {
        checks.push({ label: "FTS index: ready", level: "ok" });
      } else {
        checks.push({
          label: "FTS index: MISSING",
          level: "fail",
          fix: "Run `loreguard init` to apply migrations.",
        });
      }
      const lore = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='lore'",
        )
        .get();
      if (lore) {
        const n = (
          db.prepare("SELECT COUNT(*) AS n FROM lore").get() as { n: number }
        ).n;
        checks.push({ label: `Lore table: ${n} record(s)`, level: "ok" });
      } else {
        checks.push({ label: "Lore table: MISSING", level: "fail" });
      }
    } finally {
      db.close();
    }
  } catch (err) {
    checks.push({
      label: "DB open failed",
      level: "fail",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // 5. Audit log writable (or directory writable if log doesn't exist yet).
  if (existsSync(auditPathStr)) {
    const modeLevel = checkFileMode(auditPathStr, 0o600);
    checks.push({
      label: `Audit log: ${auditPathStr}`,
      level: modeLevel === "ok" ? "ok" : "warn",
      detail:
        modeLevel === "ok"
          ? "permissions 0600"
          : "permissions are looser than 0600 — consider tightening",
      fix: modeLevel === "warn" ? `chmod 600 ${auditPathStr}` : undefined,
    });
  } else {
    if (existsSync(dirname(auditPathStr))) {
      checks.push({
        label: `Audit log: not yet created (${auditPathStr})`,
        level: "ok",
        detail: "Will be written on first MCP tool call.",
      });
    } else {
      checks.push({
        label: `Audit log directory missing: ${dirname(auditPathStr)}`,
        level: "warn",
        fix: "Run `loreguard init` to create it.",
      });
    }
  }

  // 6. Restricted-MCP gate.
  const restrictedOn = process.env["LOREGUARD_ALLOW_RESTRICTED_MCP"] === "1";
  checks.push({
    label: `Restricted MCP access: ${restrictedOn ? "ENABLED" : "disabled"}`,
    level: restrictedOn ? "warn" : "ok",
    detail: restrictedOn
      ? "LOREGUARD_ALLOW_RESTRICTED_MCP=1 — agents can request restricted records via search_lore. Make sure this is what you want."
      : "Agents cannot fetch restricted records via MCP (the default).",
  });

  // 7. Audit-off flag.
  if (process.env["LOREGUARD_AUDIT_OFF"]) {
    checks.push({
      label: "Audit disabled: LOREGUARD_AUDIT_OFF set",
      level: "warn",
      detail: "MCP tool calls will not be logged. Not recommended outside tests.",
    });
  }

  // 8. Version.
  checks.push({ label: `Version: ${pkgVersion()}`, level: "ok" });

  const hasFail = checks.some((c) => c.level === "fail");
  return { exitCode: hasFail ? 1 : 0, checks };
}

export function renderDoctor(checks: Check[]): string {
  const lines: string[] = ["loreguard doctor", ""];
  for (const c of checks) {
    const glyph = c.level === "ok" ? "✓" : c.level === "warn" ? "!" : "✗";
    lines.push(`${glyph} ${c.label}`);
    if (c.detail) lines.push(`  ${c.detail}`);
    if (c.fix) lines.push(`  Fix: ${c.fix}`);
  }
  lines.push("");
  const hasFail = checks.some((c) => c.level === "fail");
  const hasWarn = checks.some((c) => c.level === "warn");
  if (hasFail) lines.push("Not ready. Address the ✗ items above.");
  else if (hasWarn) lines.push("Ready (with warnings).");
  else lines.push("Ready.");
  return lines.join("\n");
}
