/**
 * `loreguard setup` — collapse the three "make Claude use loreguard" steps
 * into one idempotent command:
 *
 *   1. register the MCP server with Claude Code (`claude mcp add ...`)
 *   2. append the retrieval rule to CLAUDE.md (project or user-global) so
 *      agents actually call `search_lore` at the right moments
 *   3. install the `/loreguard-onboard` skill into ~/.claude/skills/
 *
 * Each step is idempotent and reports `created` / `already-present` /
 * `skipped` distinctly. The pure file-level helpers are exported so they
 * can be unit-tested without mocking `child_process`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CLAUDE_INSTRUCTIONS } from "./instructions.js";

/**
 * HTML-comment markers wrap the retrieval rule inside CLAUDE.md. They are
 * invisible in the rendered Markdown but unique enough to detect when the
 * block has already been installed (so a second `loreguard setup` doesn't
 * append a duplicate copy).
 */
export const BEGIN_MARKER = "<!-- loreguard:retrieval-rule begin -->";
export const END_MARKER = "<!-- loreguard:retrieval-rule end -->";

export function instructionsBlock(): string {
  return `${BEGIN_MARKER}\n${CLAUDE_INSTRUCTIONS}\n${END_MARKER}\n`;
}

// ── CLAUDE.md retrieval rule ──────────────────────────────────────────

export type ClaudeMdScope = "project" | "user";

export function claudeMdPath(scope: ClaudeMdScope, cwd?: string): string {
  if (scope === "user") return join(homedir(), ".claude", "CLAUDE.md");
  return resolve(cwd ?? process.cwd(), "CLAUDE.md");
}

export type AppendAction =
  | "created"
  | "appended"
  | "already-present"
  | "replaced"
  | "skipped-partial";

export interface AppendResult {
  readonly path: string;
  readonly action: AppendAction;
}

/**
 * Idempotently append the retrieval rule to `path`. Four shapes the
 * function handles:
 *
 *   - file doesn't exist     → create it with the block
 *   - file has no markers    → append the block (with a blank-line gap)
 *   - file has both markers  → no-op, return `already-present`
 *   - file has one marker    → corrupted state, refuse unless `force`;
 *                              with `force`, the whole block (begin → end
 *                              or end → file-tail) is replaced. This is
 *                              the only place the function ever overwrites
 *                              existing bytes inside the file.
 */
export function appendInstructionsToFile(
  path: string,
  force = false,
): AppendResult {
  const block = instructionsBlock();
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, block);
    return { path, action: "created" };
  }
  const existing = readFileSync(path, "utf8");
  const beginAt = existing.indexOf(BEGIN_MARKER);
  const endAt = existing.indexOf(END_MARKER);
  const hasBegin = beginAt !== -1;
  const hasEnd = endAt !== -1;

  if (hasBegin && hasEnd) {
    // Both markers — verify the inner content matches the current rule.
    // If it does, no-op. If it doesn't (the rule was edited upstream),
    // re-render under `force`.
    const innerStart = beginAt + BEGIN_MARKER.length + 1; // skip newline
    const inner = existing.slice(innerStart, endAt).trimEnd();
    if (inner === CLAUDE_INSTRUCTIONS) {
      return { path, action: "already-present" };
    }
    if (!force) {
      return { path, action: "already-present" };
    }
    const before = existing.slice(0, beginAt);
    const after = existing.slice(endAt + END_MARKER.length);
    writeFileSync(path, before + block + after);
    return { path, action: "replaced" };
  }
  if ((hasBegin || hasEnd) && !force) {
    return { path, action: "skipped-partial" };
  }
  const sep = existing.endsWith("\n") ? "\n" : "\n\n";
  writeFileSync(path, existing + sep + block);
  return { path, action: "appended" };
}

// ── /loreguard-onboard skill ──────────────────────────────────────────

export type SkillCopyAction =
  | "copied"
  | "already-present"
  | "differs-skipped"
  | "overwritten";

export interface SkillCopyResult {
  readonly src: string;
  readonly dest: string;
  readonly action: SkillCopyAction;
}

/**
 * Resolve the bundled SKILL.md inside the installed package. The compiled
 * bin runs from `<pkg-root>/dist/bin/loreguard.js`, so the skill lives at
 * `<pkg-root>/skills/loreguard-onboard/SKILL.md` — three levels up from
 * the compiled setup module (`dist/cli/setup.js`).
 *
 * We probe a couple of relative paths to be robust against `tsx` dev runs
 * (where this module is `src/cli/setup.ts`) and packaged installs.
 */
export function findBundledSkillPath(): string {
  const here = fileURLToPath(import.meta.url);
  const candidates = [
    resolve(dirname(here), "..", "..", "skills", "loreguard-onboard", "SKILL.md"),
    resolve(dirname(here), "..", "..", "..", "skills", "loreguard-onboard", "SKILL.md"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    "could not locate bundled skill (expected at <pkg-root>/skills/loreguard-onboard/SKILL.md)",
  );
}

export function skillDestPath(home?: string): string {
  return join(
    home ?? homedir(),
    ".claude",
    "skills",
    "loreguard-onboard",
    "SKILL.md",
  );
}

/**
 * Copy `src` → `dest`. Same idempotency rules as the CLAUDE.md case:
 * already-identical is a no-op, different content is left alone unless
 * `force` is set.
 */
export function copySkillFile(
  src: string,
  dest: string,
  force = false,
): SkillCopyResult {
  const newContent = readFileSync(src, "utf8");
  if (existsSync(dest)) {
    const existing = readFileSync(dest, "utf8");
    if (existing === newContent) {
      return { src, dest, action: "already-present" };
    }
    if (!force) {
      return { src, dest, action: "differs-skipped" };
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, newContent);
    return { src, dest, action: "overwritten" };
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, newContent);
  return { src, dest, action: "copied" };
}

// ── Claude Code MCP registration ──────────────────────────────────────

export type McpAddAction =
  | "registered"
  | "already-present"
  | "claude-cli-missing"
  | "failed";

export interface McpAddResult {
  readonly action: McpAddAction;
  readonly detail?: string;
}

/**
 * Probe whether the Claude Code CLI is on PATH. Separated so a future
 * uninstall path can reuse the same probe.
 */
function probeClaudeCli(): boolean {
  try {
    execFileSync("claude", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function isLoreguardRegistered(): boolean {
  try {
    const out = execFileSync("claude", ["mcp", "list"], {
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
    return /(^|\s)loreguard(\s|:)/i.test(out);
  } catch {
    // Older Claude CLIs may not implement `mcp list` — assume not present
    // and let `mcp add` itself error if it's a real conflict.
    return false;
  }
}

export function addMcpServer(): McpAddResult {
  if (!probeClaudeCli()) {
    return {
      action: "claude-cli-missing",
      detail:
        "`claude` CLI not on PATH. Install Claude Code, or register the MCP server manually (see README).",
    };
  }
  if (isLoreguardRegistered()) {
    return { action: "already-present" };
  }
  try {
    execFileSync("claude", ["mcp", "add", "loreguard", "loreguard-mcp"], {
      stdio: "pipe",
    });
    return { action: "registered" };
  } catch (err) {
    return {
      action: "failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
