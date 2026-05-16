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
  searchLore,
  supersedeLore,
  suggestLore,
  verifyLore,
} from "../core/lore.js";
import { getBool, getString, getStringArray, parseArgs } from "./args.js";
import { renderFull, renderSummary } from "./format.js";
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
                            Flags: --repo, --tag, --since, --include-drafts,
                            --include-deprecated, --include-restricted, --limit
  show <id>                 Print the full record (body included).
  list                      Recent records across all lifecycle states.
  review                    List pending drafts awaiting approval.
  approve <id>              Promote draft → active.
  deprecate <id>            Mark deprecated.
  supersede <old-id> --with <new-id>
                            Mark <old-id> as superseded by <new-id>.
  verify <id>               Bump last_verified_at on the record.
  delete <id>               Hard-delete the record (events row preserved).
  tags                      Print all distinct tags.
  repos                     Print all distinct repos.
  audit [--n=N]             Print the last N audit log lines (default 20).
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
  const since = getString(args.flags, "since");
  const limit = Number(getString(args.flags, "limit") ?? "10");
  const includeDrafts = getBool(args.flags, "include-drafts");
  const includeDeprecated = getBool(args.flags, "include-deprecated");
  const includeRestricted = getBool(args.flags, "include-restricted");
  const db = openDb();
  try {
    const hits = searchLore(db, {
      query,
      repo,
      tag,
      since,
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

async function cmdReview(): Promise<number> {
  const db = openDb();
  try {
    const drafts = listDrafts(db);
    if (drafts.length === 0) {
      process.stdout.write("lore: no pending drafts.\n");
      return 0;
    }
    process.stdout.write(`${drafts.length} draft(s) awaiting review:\n\n`);
    for (const d of drafts) process.stdout.write(renderSummary(d) + "\n\n");
    process.stdout.write(
      "Use `lore approve <id>` to promote, or `lore show <id>` to inspect.\n",
    );
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
  const db = openDb();
  try {
    const lore = verifyLore(db, id);
    if (!lore) {
      process.stderr.write(`lore: no record with id ${id}\n`);
      return 1;
    }
    process.stdout.write(`lore: verified ${lore.id} (at ${lore.lastVerifiedAt})\n`);
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

async function cmdAudit(args: ReturnType<typeof parseArgs>): Promise<number> {
  const path =
    process.env["LORE_AUDIT_LOG"] ?? join(homedir(), ".lore", "audit.jsonl");
  if (!existsSync(path)) {
    process.stdout.write("lore: no audit log yet\n");
    return 0;
  }
  const n = Number(getString(args.flags, "n") ?? "20");
  const lines = readFileSync(path, "utf8").trim().split("\n");
  const tail = lines.slice(Math.max(0, lines.length - n));
  for (const l of tail) process.stdout.write(l + "\n");
  return 0;
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
        return await cmdReview();
      case "approve":
        return await cmdApprove(parsed);
      case "deprecate":
        return await cmdDeprecate(parsed);
      case "supersede":
        return await cmdSupersede(parsed);
      case "verify":
        return await cmdVerify(parsed);
      case "delete":
        return await cmdDelete(parsed);
      case "tags":
        return await cmdTags();
      case "repos":
        return await cmdRepos();
      case "audit":
        return await cmdAudit(parsed);
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
