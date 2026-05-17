/**
 * `loreguard setup` — pure helpers. The MCP-add piece shells out to the
 * Claude Code CLI and isn't unit-tested here (covered by smoke). These
 * tests pin the file-level idempotency contracts:
 *
 *   - appendInstructionsToFile creates / appends / no-ops / refuses
 *     partial-marker corruption / replaces under --force
 *   - copySkillFile copies / no-ops on identical content / refuses
 *     different content / overwrites under --force
 *   - claudeMdPath resolves project vs user-global correctly
 *   - findBundledSkillPath finds the SKILL.md in the package layout
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendInstructionsToFile,
  BEGIN_MARKER,
  claudeMdPath,
  copySkillFile,
  END_MARKER,
  findBundledSkillPath,
  instructionsBlock,
} from "../src/cli/setup.js";

describe("setup — appendInstructionsToFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loreguard-setup-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a fresh CLAUDE.md when one doesn't exist", () => {
    const path = join(dir, "CLAUDE.md");
    const r = appendInstructionsToFile(path);
    expect(r.action).toBe("created");
    const content = readFileSync(path, "utf8");
    expect(content).toContain(BEGIN_MARKER);
    expect(content).toContain(END_MARKER);
  });

  it("creates the parent directory when needed (e.g. ~/.claude/)", () => {
    const nested = join(dir, ".claude", "CLAUDE.md");
    const r = appendInstructionsToFile(nested);
    expect(r.action).toBe("created");
    expect(existsSync(nested)).toBe(true);
  });

  it("appends the block (with separator) when CLAUDE.md exists but has no markers", () => {
    const path = join(dir, "CLAUDE.md");
    writeFileSync(path, "# Project rules\n\nUse strict mode.\n");
    const r = appendInstructionsToFile(path);
    expect(r.action).toBe("appended");
    const content = readFileSync(path, "utf8");
    expect(content.startsWith("# Project rules")).toBe(true);
    expect(content).toContain(BEGIN_MARKER);
    expect(content).toContain(END_MARKER);
  });

  it("no-ops when both markers are present and the inner content matches", () => {
    const path = join(dir, "CLAUDE.md");
    writeFileSync(path, "existing content\n\n" + instructionsBlock());
    const r = appendInstructionsToFile(path);
    expect(r.action).toBe("already-present");
    // File contents unchanged.
    const content = readFileSync(path, "utf8");
    // Markers appear exactly once.
    expect(content.split(BEGIN_MARKER)).toHaveLength(2);
    expect(content.split(END_MARKER)).toHaveLength(2);
  });

  it("refuses when only one marker is present (corrupted) without --force", () => {
    const path = join(dir, "CLAUDE.md");
    writeFileSync(path, "stuff\n" + BEGIN_MARKER + "\nbroken half\n");
    const r = appendInstructionsToFile(path);
    expect(r.action).toBe("skipped-partial");
  });

  it("replaces the block under --force when inner content drifted", () => {
    const path = join(dir, "CLAUDE.md");
    // Plant a block with the markers but stale inner content.
    writeFileSync(
      path,
      "preface\n\n" + BEGIN_MARKER + "\nold stale rule\n" + END_MARKER + "\ntrailer\n",
    );
    const r = appendInstructionsToFile(path, true);
    expect(r.action).toBe("replaced");
    const content = readFileSync(path, "utf8");
    // Preface and trailer survive; the inner content is now the current block.
    expect(content.startsWith("preface")).toBe(true);
    expect(content).toContain("trailer");
    // Markers still exactly once.
    expect(content.split(BEGIN_MARKER)).toHaveLength(2);
    expect(content.split(END_MARKER)).toHaveLength(2);
  });
});

describe("setup — claudeMdPath", () => {
  it("resolves project scope relative to cwd", () => {
    expect(claudeMdPath("project", "/tmp/some-repo")).toBe(
      "/tmp/some-repo/CLAUDE.md",
    );
  });
  it("resolves user scope to ~/.claude/CLAUDE.md", () => {
    const p = claudeMdPath("user");
    expect(p.endsWith("/.claude/CLAUDE.md")).toBe(true);
  });
});

describe("setup — copySkillFile", () => {
  let dir: string;
  let src: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loreguard-skill-"));
    src = join(dir, "src", "SKILL.md");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(src, "skill v1\n");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("copies the file into a new destination", () => {
    const dest = join(dir, "out", "SKILL.md");
    const r = copySkillFile(src, dest);
    expect(r.action).toBe("copied");
    expect(readFileSync(dest, "utf8")).toBe("skill v1\n");
  });

  it("no-ops when destination already has identical content", () => {
    const dest = join(dir, "out", "SKILL.md");
    mkdirSync(join(dir, "out"), { recursive: true });
    writeFileSync(dest, "skill v1\n");
    const r = copySkillFile(src, dest);
    expect(r.action).toBe("already-present");
  });

  it("refuses when destination differs without --force", () => {
    const dest = join(dir, "out", "SKILL.md");
    mkdirSync(join(dir, "out"), { recursive: true });
    writeFileSync(dest, "user-edited skill\n");
    const r = copySkillFile(src, dest);
    expect(r.action).toBe("differs-skipped");
    // Destination untouched.
    expect(readFileSync(dest, "utf8")).toBe("user-edited skill\n");
  });

  it("overwrites when destination differs and --force is set", () => {
    const dest = join(dir, "out", "SKILL.md");
    mkdirSync(join(dir, "out"), { recursive: true });
    writeFileSync(dest, "user-edited skill\n");
    const r = copySkillFile(src, dest, true);
    expect(r.action).toBe("overwritten");
    expect(readFileSync(dest, "utf8")).toBe("skill v1\n");
  });
});

describe("setup — findBundledSkillPath", () => {
  it("locates the SKILL.md in the package layout (tsx dev mode)", () => {
    // In tests, this module runs under tsx from src/cli/setup.ts; the
    // skill is two levels up from that. Just assert the path exists.
    const p = findBundledSkillPath();
    expect(p.endsWith("/skills/loreguard-onboard/SKILL.md")).toBe(true);
    expect(existsSync(p)).toBe(true);
  });
});
