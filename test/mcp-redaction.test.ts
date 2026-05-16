/**
 * MCP restricted-get gate. `search_lore` env-gates restricted records via
 * LOREGUARD_ALLOW_RESTRICTED_MCP; `get_lore` must enforce the same gate so an
 * agent with a known id can't sidestep the search filter. These tests
 * exercise the pure helpers (no stdio harness required).
 */
import { describe, expect, it } from "vitest";

import { redactRestricted, shouldGateRestrictedGet } from "../src/mcp/redact.js";

describe("redactRestricted", () => {
  it("returns a minimal refusal shape — no title, summary, body, source, or timestamps", () => {
    const r = redactRestricted("abc12345");
    expect(r).toEqual({
      id: "abc12345",
      restricted: true,
      error: "restricted",
      hint: "Set LOREGUARD_ALLOW_RESTRICTED_MCP=1 to allow MCP access to restricted lore.",
    });
    // Spell out the negatives in case the shape grows by accident later.
    const keys = Object.keys(r);
    expect(keys).not.toContain("title");
    expect(keys).not.toContain("summary");
    expect(keys).not.toContain("body");
    expect(keys).not.toContain("source");
    expect(keys).not.toContain("repos");
    expect(keys).not.toContain("tags");
    expect(keys).not.toContain("updatedAt");
    expect(keys).not.toContain("createdAt");
  });
});

describe("shouldGateRestrictedGet", () => {
  it("returns false when the record is null (unknown id)", () => {
    expect(shouldGateRestrictedGet(null, {})).toBe(false);
  });

  it("returns false for non-restricted records, gate set or not", () => {
    expect(shouldGateRestrictedGet({ restricted: false }, {})).toBe(false);
    expect(
      shouldGateRestrictedGet(
        { restricted: false },
        { LOREGUARD_ALLOW_RESTRICTED_MCP: "1" },
      ),
    ).toBe(false);
  });

  it("returns true when restricted and the env gate is unset", () => {
    expect(shouldGateRestrictedGet({ restricted: true }, {})).toBe(true);
  });

  it("returns true when restricted and the env gate is anything other than '1'", () => {
    expect(
      shouldGateRestrictedGet(
        { restricted: true },
        { LOREGUARD_ALLOW_RESTRICTED_MCP: "" },
      ),
    ).toBe(true);
    expect(
      shouldGateRestrictedGet(
        { restricted: true },
        { LOREGUARD_ALLOW_RESTRICTED_MCP: "yes" },
      ),
    ).toBe(true);
    expect(
      shouldGateRestrictedGet(
        { restricted: true },
        { LOREGUARD_ALLOW_RESTRICTED_MCP: "0" },
      ),
    ).toBe(true);
    expect(
      shouldGateRestrictedGet(
        { restricted: true },
        { LOREGUARD_ALLOW_RESTRICTED_MCP: "true" },
      ),
    ).toBe(true);
  });

  it("returns false when restricted and the env gate is explicitly '1'", () => {
    expect(
      shouldGateRestrictedGet(
        { restricted: true },
        { LOREGUARD_ALLOW_RESTRICTED_MCP: "1" },
      ),
    ).toBe(false);
  });
});
