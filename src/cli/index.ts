import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { openDb } from "../db/index.js";
import type { LoreConfidence } from "../db/types.js";
import {
  addLore,
  approveLore,
  deleteLore,
  deprecateLore,
  getLore,
  listDrafts,
  listRecent,
  listRepos,
  listTags,
  rejectLore,
  searchLore,
  supersedeLore,
  suggestLore,
  updateLore,
  verifyLore,
} from "../core/lore.js";
import { getBool, getString, getStringArray, parseArgs } from "./args.js";
import { renderDoctor, runDoctor } from "./doctor.js";
import { renderFull, renderSummary } from "./format.js";
import { renderClaudeInstructions } from "./instructions.js";
import { prompt, promptMulti } from "./prompt.js";

const HELP = `lore — local memory for AI coding agents

USAGE
  lore <command> [options]

COMMANDS
  init                      Create / migrate the local DB
  add                       Add a note (human, status=active). Interactive
                            unless --title is given.
  suggest                   Same as add but lands as a draft. Used by agents;
                            also handy when you want to triage later.
  search <query...>         Full-text search. Returns brief summaries.
                            Flags: --repo, --tag, --updated-after,
                            --include-drafts, --include-deprecated,
                            --include-restricted, --limit
  show <id>                 Print the full record (body included).
  list                      Recent records across all lifecycle states.
  review [--list]           Interactive triage queue: show each pending
                            draft and ask [a]pprove / [r]eject / [e]dit /
                            [s]kip / [q]uit. Use --list (or pipe to stdout)
                            for the non-interactive list view.
  approve <id>              Promote draft → active.
  reject <id>               Drop a draft. Refuses non-drafts (use
                            deprecate instead). Emits a 'rejected' event
                            so the audit chain shows the triage decision.
  deprecate <id>            Mark deprecated.
  supersede <old-id> --with <new-id>
                            Mark <old-id> as superseded by <new-id>.
  verify <id> [--review-after <iso-date>]
                            Bump last_verified_at; if review-after has
                            lapsed, push it 90 days forward (or use the
                            value you pass with --review-after).
  update <id> [--title ... --summary ... --body ... --source ... etc.]
                            Edit fields on an existing record. Useful
                            for fixing an agent's draft before approving.
  delete <id>               Hard-delete the record (events row preserved).
  tags                      Print all distinct tags.
  repos                     Print all distinct repos.
  audit [--n=N] [--raw]     Print the last N audit log lines (default 20)
                            in a redacted human-readable form. Use --raw
                            to see the full JSON instead.
  doctor                    Health-check the local install: DB exists,
                            permissions, FTS index, audit log, restricted
                            MCP gate, version. Exits non-zero on hard
                            failures, zero on warnings.
  print-claude-instructions
                            Print the retrieval rule to paste into
                            your CLAUDE.md / agent instructions so the
                            agent reliably calls search_lore.
  mcp                       Run the MCP server on stdio (same as lore-mcp).

EXAMPLES
  lore add --title "Argon2id is the default" --summary "..." --body "..."
  lore search "password hashing" --repo payments-svc
  lore review
  lore approve 7vk3qm9b
`;

async function cmdInit(): Promise<number> {
  const db = openDb();
  db.close();
  // openDb runs migrations and creates the file with 0600 perms.
  process.stdout.write("lore: initialised at ~/.lore/lore.db\n");
  return 0;
}

function parseConfidence(v: string | undefined): LoreConfidence | undefined {
  if (v === undefined) return undefined;
  if (v === "low" || v === "medium" || v === "high") return v;
  throw new Error(`invalid --confidence: ${v} (must be low | medium | high)`);
}

function parseLimit(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    throw new Error(`invalid --limit: ${v} (must be an integer between 1 and 50)`);
  }
  return n;
}

async function cmdAdd(args: ReturnType<typeof parseArgs>, asDraft: boolean): Promise<number> {
  let title = getString(args.flags, "title");
  let summary = getString(args.flags, "summary");
  let body = getString(args.flags, "body");

  if (!title) title = (await prompt("Title: ")).trim();
  if (!title) {
    process.stderr.write("lore: title is required\n");
    return 1;
  }
  if (!summary) summary = (await prompt("Summary (one line): ")).trim();
  if (!body) body = (await promptMulti("Body:")).trim();
  if (!body) body = summary; // body falls back to summary if user skipped

  const repos = getStringArray(args.flags, "repo");
  const tags = getStringArray(args.flags, "tag");
  const team = getString(args.flags, "team");
  const author = getString(args.flags, "author") ?? process.env["USER"];
  const source = getString(args.flags, "source");
  const reviewAfter = getString(args.flags, "review-after");
  const confidence = parseConfidence(getString(args.flags, "confidence"));
  const restricted = getBool(args.flags, "restricted");

  const db = openDb();
  try {
    const fn = asDraft ? suggestLore : addLore;
    const lore = fn(db, {
      title,
      summary,
      body,
      repos,
      tags,
      team,
      author,
      source,
      reviewAfter,
      confidence,
      restricted,
    });
    process.stdout.write(
      `lore: ${asDraft ? "suggested" : "added"} ${lore.id} (${lore.status})\n`,
    );
    return 0;
  } finally {
    db.close();
  }
}

async function cmdSearch(args: ReturnType<typeof parseArgs>): Promise<number> {
  const query = args.positionals.join(" ").trim() || undefined;
  const repo = getString(args.flags, "repo");
  const tag = getString(args.flags, "tag");
  // Accept either spelling; `--updated-after` is canonical, `--since` is kept
  // as a friendly alias.
  const updatedAfter =
    getString(args.flags, "updated-after") ?? getString(args.flags, "since");
  const limit = parseLimit(getString(args.flags, "limit")) ?? 10;
  const includeDrafts = getBool(args.flags, "include-drafts");
  const includeDeprecated = getBool(args.flags, "include-deprecated");
  const includeRestricted = getBool(args.flags, "include-restricted");
  const db = openDb();
  try {
    const hits = searchLore(db, {
      query,
      repo,
      tag,
      updatedAfter,
      limit,
      includeDrafts,
      includeDeprecated,
      includeRestricted,
    });
    if (hits.length === 0) {
      process.stdout.write("lore: no matches\n");
      return 0;
    }
    for (const h of hits) {
      process.stdout.write(renderSummary(h) + "\n\n");
    }
    return 0;
  } finally {
    db.close();
  }
}

async function cmdShow(args: ReturnType<typeof parseArgs>): Promise<number> {
  const id = args.positionals[0];
  if (!id) {
    process.stderr.write("lore: show <id> requires an id\n");
    return 2;
  }
  const db = openDb();
  try {
    const lore = getLore(db, id);
    if (!lore) {
      process.stderr.write(`lore: no record with id ${id}\n`);
      return 1;
    }
    process.stdout.write(renderFull(lore) + "\n");
    return 0;
  } finally {
    db.close();
  }
}

async function cmdList(): Promise<number> {
  const db = openDb();
  try {
    const hits = listRecent(db, 50);
    if (hits.length === 0) {
      process.stdout.write("lore: nothing here yet — try `lore add`.\n");
      return 0;
    }
    for (const h of hits) process.stdout.write(renderSummary(h) + "\n\n");
    return 0;
  } finally {
    db.close();
  }
}

async function cmdReview(args: ReturnType<typeof parseArgs>): Promise<number> {
  const db = openDb();
  try {
    const drafts = listDrafts(db);
    if (drafts.length === 0) {
      process.stdout.write("lore: no pending drafts.\n");
      return 0;
    }

    // Two modes: default is interactive (per-draft a/r/e/s/q triage).
    // `--list` or non-TTY stdin falls back to the old "print them all" view
    // so `lore review | grep` doesn't hang.
    const listOnly =
      getBool(args.flags, "list") || !process.stdin.isTTY;

    if (listOnly) {
      process.stdout.write(`${drafts.length} draft(s) awaiting review:\n\n`);
      for (const d of drafts) process.stdout.write(renderSummary(d) + "\n\n");
      process.stdout.write(
        "Use `lore approve <id>` to promote, or `lore reject <id>` to drop.\n",
      );
      return 0;
    }

    // Interactive triage queue. Iterate drafts oldest-first (createdAt asc
    // happens to also be the natural triage order — first in, first reviewed).
    process.stdout.write(
      `${drafts.length} draft(s) awaiting review. Press q to quit at any time.\n\n`,
    );
    let approved = 0;
    let rejected = 0;
    let skipped = 0;
    for (let i = 0; i < drafts.length; i++) {
      const d = drafts[i]!;
      const full = getLore(db, d.id);
      if (!full) continue; // raced / deleted

      process.stdout.write(`── Draft ${i + 1} of ${drafts.length} ──\n`);
      process.stdout.write(renderFull(full) + "\n\n");
      const answer = (
        await prompt("[a]pprove  [r]eject  [e]dit  [s]kip  [q]uit  > ")
      )
        .trim()
        .toLowerCase();

      if (answer === "q" || answer === "quit" || answer === "exit") {
        process.stdout.write("\nlore: stopped.\n");
        break;
      }
      if (answer === "a" || answer === "approve" || answer === "y") {
        const promoted = approveLore(db, d.id);
        process.stdout.write(
          promoted
            ? `✓ approved ${d.id}\n\n`
            : `✗ could not approve ${d.id}\n\n`,
        );
        if (promoted) approved++;
        continue;
      }
      if (answer === "r" || answer === "reject" || answer === "n") {
        const ok = rejectLore(db, d.id);
        process.stdout.write(
          ok ? `✗ rejected ${d.id}\n\n` : `! could not reject ${d.id}\n\n`,
        );
        if (ok) rejected++;
        continue;
      }
      if (answer === "e" || answer === "edit") {
        // Don't reach for $EDITOR yet — print the update command the user
        // can paste with their preferred shell tooling. Keeps the prompt
        // loop simple; user can come back to `lore review` next.
        process.stdout.write(
          `\nTo edit this draft, run:\n` +
            `  lore update ${d.id} --summary "..." --body "..."\n` +
            `Then re-run \`lore review\` to triage it again.\n\n`,
        );
        skipped++;
        continue;
      }
      // Anything else (including bare Enter) is treated as skip.
      process.stdout.write(`… skipped ${d.id}\n\n`);
      skipped++;
    }

    const tally =
      `approved: ${approved}  rejected: ${rejected}  skipped: ${skipped}`;
    process.stdout.write(`\nReview complete. ${tally}\n`);
    return 0;
  } finally {
    db.close();
  }
}

async function cmdReject(args: ReturnType<typeof parseArgs>): Promise<number> {
  const id = args.positionals[0];
  if (!id) {
    process.stderr.write("lore: reject <id> requires an id\n");
    return 2;
  }
  const db = openDb();
  try {
    const ok = rejectLore(db, id);
    if (!ok) {
      process.stderr.write(
        `lore: cannot reject ${id} (unknown id or not a draft; use \`lore deprecate\` for active records)\n`,
      );
      return 1;
    }
    process.stdout.write(`lore: rejected ${id}\n`);
    return 0;
  } finally {
    db.close();
  }
}

async function cmdApprove(args: ReturnType<typeof parseArgs>): Promise<number> {
  const id = args.positionals[0];
  if (!id) {
    process.stderr.write("lore: approve <id> requires an id\n");
    return 2;
  }
  const db = openDb();
  try {
    const lore = approveLore(db, id);
    if (!lore) {
      process.stderr.write(
        `lore: ${id} is not a pending draft (already active, deprecated, or unknown)\n`,
      );
      return 1;
    }
    process.stdout.write(`lore: approved ${lore.id}\n`);
    return 0;
  } finally {
    db.close();
  }
}

async function cmdDeprecate(args: ReturnType<typeof parseArgs>): Promise<number> {
  const id = args.positionals[0];
  if (!id) {
    process.stderr.write("lore: deprecate <id> requires an id\n");
    return 2;
  }
  const db = openDb();
  try {
    const lore = deprecateLore(db, id);
    if (!lore) {
      process.stderr.write(`lore: no record with id ${id}\n`);
      return 1;
    }
    process.stdout.write(`lore: deprecated ${lore.id}\n`);
    return 0;
  } finally {
    db.close();
  }
}

async function cmdSupersede(args: ReturnType<typeof parseArgs>): Promise<number> {
  const oldId = args.positionals[0];
  const newId = getString(args.flags, "with");
  if (!oldId || !newId) {
    process.stderr.write("lore: supersede <old-id> --with <new-id>\n");
    return 2;
  }
  const db = openDb();
  try {
    const lore = supersedeLore(db, oldId, newId);
    if (!lore) {
      process.stderr.write(
        `lore: couldn't supersede ${oldId} with ${newId} (check both ids exist and are not the same)\n`,
      );
      return 1;
    }
    process.stdout.write(
      `lore: ${oldId} superseded by ${newId}\n`,
    );
    return 0;
  } finally {
    db.close();
  }
}

async function cmdVerify(args: ReturnType<typeof parseArgs>): Promise<number> {
  const id = args.positionals[0];
  if (!id) {
    process.stderr.write("lore: verify <id> requires an id\n");
    return 2;
  }
  const reviewAfter = getString(args.flags, "review-after");
  const db = openDb();
  try {
    const lore = verifyLore(db, id, reviewAfter);
    if (!lore) {
      process.stderr.write(`lore: no record with id ${id}\n`);
      return 1;
    }
    process.stdout.write(
      `lore: verified ${lore.id}` +
        ` (at ${lore.lastVerifiedAt}` +
        (lore.reviewAfter ? `; next review ${lore.reviewAfter}` : "") +
        `)\n`,
    );
    return 0;
  } finally {
    db.close();
  }
}

async function cmdUpdate(args: ReturnType<typeof parseArgs>): Promise<number> {
  const id = args.positionals[0];
  if (!id) {
    process.stderr.write("lore: update <id> requires an id\n");
    return 2;
  }
  const title = getString(args.flags, "title");
  const summary = getString(args.flags, "summary");
  const body = getString(args.flags, "body");
  const source = getString(args.flags, "source");
  const reviewAfter = getString(args.flags, "review-after");
  const confidence = parseConfidence(getString(args.flags, "confidence"));
  const team = getString(args.flags, "team");
  const author = getString(args.flags, "author");
  const reposFlag = getStringArray(args.flags, "repo");
  const tagsFlag = getStringArray(args.flags, "tag");
  const clearSource = getBool(args.flags, "clear-source");
  const clearRepos = getBool(args.flags, "clear-repos");
  const clearTags = getBool(args.flags, "clear-tags");
  const restricted = args.flags["restricted"] === true
    ? true
    : args.flags["unrestricted"] === true
      ? false
      : undefined;

  // R5 — refuse contradictory combinations rather than silently picking one.
  if (clearSource && source !== undefined) {
    process.stderr.write(
      "lore: --clear-source conflicts with --source <url>; pick one\n",
    );
    return 2;
  }
  if (clearRepos && reposFlag.length > 0) {
    process.stderr.write(
      "lore: --clear-repos conflicts with --repo; pick one\n",
    );
    return 2;
  }
  if (clearTags && tagsFlag.length > 0) {
    process.stderr.write(
      "lore: --clear-tags conflicts with --tag; pick one\n",
    );
    return 2;
  }

  // Build a tight partial-input — only include keys the user actually passed.
  const patch: Record<string, unknown> = {};
  if (title !== undefined) patch["title"] = title;
  if (summary !== undefined) patch["summary"] = summary;
  if (body !== undefined) patch["body"] = body;
  if (clearSource) patch["source"] = "";
  else if (source !== undefined) patch["source"] = source;
  if (reviewAfter !== undefined) patch["reviewAfter"] = reviewAfter;
  if (confidence !== undefined) patch["confidence"] = confidence;
  if (team !== undefined) patch["team"] = team;
  if (author !== undefined) patch["author"] = author;
  if (clearRepos) patch["repos"] = [];
  else if (reposFlag.length > 0) patch["repos"] = reposFlag;
  if (clearTags) patch["tags"] = [];
  else if (tagsFlag.length > 0) patch["tags"] = tagsFlag;
  if (restricted !== undefined) patch["restricted"] = restricted;

  if (Object.keys(patch).length === 0) {
    process.stderr.write(
      "lore: update needs at least one field flag (--title, --summary, --body, --source, --clear-source, --review-after, --confidence, --team, --repo, --clear-repos, --tag, --clear-tags, --restricted/--unrestricted)\n",
    );
    return 2;
  }

  const db = openDb();
  try {
    const lore = updateLore(db, id, patch as Parameters<typeof updateLore>[2]);
    if (!lore) {
      process.stderr.write(`lore: no record with id ${id}\n`);
      return 1;
    }
    process.stdout.write(`lore: updated ${lore.id}\n`);
    return 0;
  } finally {
    db.close();
  }
}

async function cmdDelete(args: ReturnType<typeof parseArgs>): Promise<number> {
  const id = args.positionals[0];
  if (!id) {
    process.stderr.write("lore: delete <id> requires an id\n");
    return 2;
  }
  const db = openDb();
  try {
    const ok = deleteLore(db, id);
    if (!ok) {
      process.stderr.write(`lore: no record with id ${id}\n`);
      return 1;
    }
    process.stdout.write(`lore: deleted ${id}\n`);
    return 0;
  } finally {
    db.close();
  }
}

async function cmdTags(): Promise<number> {
  const db = openDb();
  try {
    const ts = listTags(db);
    if (ts.length === 0) {
      process.stdout.write("lore: no tags yet\n");
      return 0;
    }
    process.stdout.write(ts.join("\n") + "\n");
    return 0;
  } finally {
    db.close();
  }
}

async function cmdRepos(): Promise<number> {
  const db = openDb();
  try {
    const rs = listRepos(db);
    if (rs.length === 0) {
      process.stdout.write("lore: no repos yet\n");
      return 0;
    }
    process.stdout.write(rs.join("\n") + "\n");
    return 0;
  } finally {
    db.close();
  }
}

async function cmdDoctor(): Promise<number> {
  const { exitCode, checks } = runDoctor();
  process.stdout.write(renderDoctor(checks) + "\n");
  return exitCode;
}

/**
 * Audit display. Default is a redacted human-readable form:
 *
 *   2026-05-16T11:32:18Z  search_lore  q="password hashing" repo=payments-svc  → 2 hits
 *
 * The on-disk JSONL never contains result bodies (the audit module already
 * scrubs those before write — see audit.test.ts), but raw JSON exposes
 * search queries and titles that might carry sensitive intent. `--raw`
 * opts back into full JSON for power users who explicitly want it.
 */
async function cmdAudit(args: ReturnType<typeof parseArgs>): Promise<number> {
  const path =
    process.env["LORE_AUDIT_LOG"] ?? join(homedir(), ".lore", "audit.jsonl");
  if (!existsSync(path)) {
    process.stdout.write("lore: no audit log yet\n");
    return 0;
  }
  const n = Number(getString(args.flags, "n") ?? "20");
  const raw = getBool(args.flags, "raw");
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  const tail = lines.slice(Math.max(0, lines.length - n));
  if (raw) {
    for (const l of tail) process.stdout.write(l + "\n");
    return 0;
  }
  for (const l of tail) {
    process.stdout.write(formatAuditLine(l) + "\n");
  }
  return 0;
}

/**
 * Render a single audit JSONL row as a short, redacted one-liner.
 * Falls back to the raw line if it can't be parsed — never throws.
 */
function formatAuditLine(line: string): string {
  let row: {
    ts?: string;
    tool?: string;
    request?: Record<string, unknown>;
    resultCount?: number;
    resultIds?: string[];
    error?: string;
  };
  try {
    row = JSON.parse(line);
  } catch {
    return line;
  }
  const ts = (row.ts ?? "").replace(/\.\d+Z$/, "Z");
  const tool = row.tool ?? "?";
  const req = row.request ?? {};
  const reqBits: string[] = [];
  if (tool === "search_lore") {
    if (typeof req["query"] === "string") {
      reqBits.push(`q="${redactQuery(req["query"] as string)}"`);
    }
    if (req["repo"]) reqBits.push(`repo=${String(req["repo"])}`);
    if (req["tag"]) reqBits.push(`tag=${String(req["tag"])}`);
    if (req["includeRestricted"]) reqBits.push("+restricted");
    if (req["includeDrafts"]) reqBits.push("+drafts");
  } else if (tool === "suggest_lore") {
    if (typeof req["title"] === "string") {
      reqBits.push(`title="${redactTitle(req["title"] as string)}"`);
    }
    if (typeof req["bodyChars"] === "number") {
      reqBits.push(`bodyChars=${req["bodyChars"]}`);
    }
    if (req["source"]) reqBits.push(`source=${String(req["source"])}`);
    if (req["confidence"]) reqBits.push(`conf=${String(req["confidence"])}`);
  } else if (tool === "get_lore") {
    if (req["id"]) reqBits.push(`id=${String(req["id"])}`);
  } else {
    // Unknown tool — show keys, not values.
    for (const k of Object.keys(req)) reqBits.push(k);
  }
  const result = row.error
    ? `→ ERR: ${row.error}`
    : row.resultCount !== undefined
      ? `→ ${row.resultCount} hit${row.resultCount === 1 ? "" : "s"}`
      : "";
  return `${ts}  ${tool}  ${reqBits.join(" ")}  ${result}`.trim();
}

/** Truncate long search queries to keep the audit display tidy + privacy-respecting. */
function redactQuery(q: string): string {
  if (q.length <= 60) return q;
  return q.slice(0, 57) + "…";
}

/** Same for titles. */
function redactTitle(t: string): string {
  if (t.length <= 50) return t;
  return t.slice(0, 47) + "…";
}

export async function main(argv: ReadonlyArray<string>): Promise<number> {
  const [, , ...rest] = argv;
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if (rest[0] === "--version" || rest[0] === "-v") {
    // Static for now — populated from package.json at build time later.
    process.stdout.write("0.1.0\n");
    return 0;
  }
  const [cmd, ...subArgs] = rest;
  const parsed = parseArgs(subArgs);
  try {
    switch (cmd) {
      case "init":
        return await cmdInit();
      case "add":
        return await cmdAdd(parsed, false);
      case "suggest":
        return await cmdAdd(parsed, true);
      case "search":
        return await cmdSearch(parsed);
      case "show":
        return await cmdShow(parsed);
      case "list":
        return await cmdList();
      case "review":
        return await cmdReview(parsed);
      case "approve":
        return await cmdApprove(parsed);
      case "reject":
        return await cmdReject(parsed);
      case "deprecate":
        return await cmdDeprecate(parsed);
      case "supersede":
        return await cmdSupersede(parsed);
      case "verify":
        return await cmdVerify(parsed);
      case "update":
      case "edit":
        return await cmdUpdate(parsed);
      case "delete":
        return await cmdDelete(parsed);
      case "tags":
        return await cmdTags();
      case "repos":
        return await cmdRepos();
      case "audit":
        return await cmdAudit(parsed);
      case "doctor":
        return await cmdDoctor();
      case "print-claude-instructions":
      case "instructions":
        process.stdout.write(renderClaudeInstructions());
        return 0;
      case "mcp":
        {
          const { runMcpServer } = await import("../mcp/server.js");
          await runMcpServer();
          return 0;
        }
      default:
        process.stderr.write(`lore: unknown command '${cmd}'\n${HELP}`);
        return 2;
    }
  } catch (err) {
    process.stderr.write(
      `lore: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}
