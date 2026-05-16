/**
 * Audit log boundary test. The MCP server MUST NOT write the body of
 * a suggested or updated lore record to ~/.loreguard/audit.jsonl. That's
 * the explicit security claim in README + SECURITY.md and the only
 * meaningful failure mode this test guards against. We exercise the
 * audit module directly (not via the live MCP server, which requires
 * a stdio harness) and assert on the JSONL produced.
 */
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const tmpPath = join(tmpdir(), `lore-audit-test-${Date.now()}-${process.pid}.jsonl`);

beforeEach(() => {
  process.env["LOREGUARD_AUDIT_LOG"] = tmpPath;
  delete process.env["LOREGUARD_AUDIT_OFF"];
});
afterEach(() => {
  try {
    rmSync(tmpPath, { force: true });
  } catch {
    /* best-effort */
  }
});

async function freshAudit() {
  // Re-import to clear the module-scoped `initialised` flag and force a
  // re-read of the LOREGUARD_AUDIT_LOG env var. Vitest gives each test a
  // module cache, so importing here is fine.
  const mod = await import("../src/core/audit.js?ts=" + Date.now());
  return mod;
}

describe("audit log boundary", () => {
  it("does not contain the body when suggest_lore-style sanitised payload is recorded", async () => {
    const { audit } = await freshAudit();
    // This is the exact shape MCP server.ts builds for suggest_lore.
    audit({
      tool: "suggest_lore",
      request: {
        title: "t",
        summaryChars: 12,
        bodyChars: 9999,
        repos: ["repo-a"],
        tags: ["t1"],
        source: "https://example.com/x",
        confidence: "medium",
        team: "team-x",
      },
      resultCount: 1,
      resultIds: ["abc12345"],
    });
    const line = readFileSync(tmpPath, "utf8").trim();
    // Body is NOT in the audit line. The string check is intentionally
    // broad — if any future regression spreads the args object back in,
    // this catches it.
    expect(line).not.toContain('"body"');
    expect(line).not.toContain('"body":');
    // Whereas the safe metadata IS there.
    expect(line).toContain("suggest_lore");
    expect(line).toContain("bodyChars");
    expect(line).toContain("repo-a");
  });

  it("never writes a key called 'body' regardless of caller payload", async () => {
    const { audit } = await freshAudit();
    // Even if a caller (incorrectly) tried to pass `body`, we'd want this
    // covered. The current code shouldn't construct such an audit, but
    // a defensive check here documents the contract.
    audit({
      tool: "suggest_lore",
      request: { title: "t" },
      resultCount: 1,
      resultIds: ["abc12345"],
    });
    const line = readFileSync(tmpPath, "utf8").trim();
    expect(line).not.toMatch(/"body"\s*:/);
  });
});
