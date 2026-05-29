import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { execSync } from "node:child_process";

import {
  findActiveAbsence,
  listAbsences,
  pruneExpiredAbsences,
  recordAbsence,
} from "../core/absence.js";
import { defaultDbPath, openDb } from "../db/index.js";
import type { LoreConfidence } from "../db/types.js";
import {
  addLore,
  approveLore,
  deleteLore,
  deprecateLore,
  exportLore,
  findPossibleDuplicates,
  getLore,
  listDrafts,
  listRecent,
  listRepos,
  listTags,
  pruneReadEvents,
  rejectLore,
  searchLore,
  searchLoreCount,
  supersedeLore,
  suggestLore,
  updateLore,
  verifyLore,
} from "../core/lore.js";
import { getBool, getString, getStringArray, parseArgs } from "./args.js";
import { cleanDemo, countLore, seedDemo } from "./demo.js";
import { renderDoctor, runDoctor } from "./doctor.js";
import { renderFull, renderSummary } from "./format.js";
import {
  INDUCTION_QUESTIONS,
  type InductionAnswer,
  runInduct,
  shortInductionQuestions,
  shortRepoNameFromRemote,
} from "./induct.js";
import { renderClaudeInstructions } from "./instructions.js";
import { prompt, promptMulti } from "./prompt.js";
import {
  addMcpServer,
  appendInstructionsToFile,
  claudeMdPath,
  type ClaudeMdScope,
  copySkillFile,
  detectIngestSources,
  findBundledSkillPath,
  skillDestPath,
} from "./setup.js";
import { exportToDir, findLoreguardDirs, importFromDir } from "./sync.js";

const HELP = `loreguard — reviewed project memory for AI coding agents

USAGE
  loreguard <command> [options]

COMMANDS
  init                      Create / migrate the local DB
  add                       Add a note (human, status=active). Interactive
                            unless --title is given.
  suggest                   Same as add but lands as a draft. Used by agents;
                            also handy when you want to triage later.
  search <query...>         Full-text search. Returns brief summaries.
                            Flags: --repo, --tag (repeatable for ANY-of),
                            --prefix (match tokens of 3+ chars as
                            prefixes), --updated-after, --include-drafts,
                            --include-deprecated, --include-superseded,
                            --include-restricted, --limit
  show <id>                 Print the full record (body included).
  list                      Recent records across all lifecycle states.
  review [--list]           Interactive triage queue: show each pending
                            draft and ask [a]pprove / [r]eject / [e]dit /
                            [s]kip / [q]uit. Use --list (or pipe to stdout)
                            for the non-interactive list view.
  approve <id>              Promote draft → active.
  reject <id> [--reason "..."]
                            Drop a draft. Refuses non-drafts (use
                            deprecate instead). Emits a 'rejected' event
                            so the audit chain shows the triage decision.
                            --reason is optional but recommended — gives
                            the agent (or future-you) a record of WHY
                            the draft was dropped.
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
  export [--out <path>]     Export lore as a single JSON document
                            (envelope: { schemaVersion, exportedAt,
                            records }). Default: active + non-restricted
                            only, stable ordering by updated_at desc.
                            Without --out, writes to stdout. With --out,
                            writes the file with mode 0600.
                            Opt-ins: --include-drafts,
                            --include-deprecated, --include-superseded,
                            --include-restricted.
  sync export <dir> [--clean]
                            Write one .md file per record into <dir>
                            (e.g. .loreguard/) — PR-reviewable team lore.
                            Active + non-restricted by default; same
                            --include-* opt-ins as \`export\`. Pass --clean
                            to remove existing <id>.md files in <dir>
                            before writing (only files matching the
                            8-char id pattern; hand-written .md files
                            are left alone).
  sync import <dir>         Read every *.md file in <dir> and upsert
                            into the local DB. Restricted records are
                            skipped unless --include-restricted is set.
                            Imports respect the file's declared status
                            (the PR is the review gate).
  sync pull <parent>        Recursively discover every .loreguard/
                            directory under <parent> and import each.
                            One command bootstraps a fresh machine
                            across every repo in your workspace tree.
                            Same flags as \`sync import\`. Skips heavy
                            directories (node_modules, .git, dist,
                            build, target, vendor, etc.).
  audit [--n=N] [--raw]     Print the last N audit log lines (default 20)
                            in a redacted human-readable form. Use --raw
                            to see the full JSON instead.
  doctor                    Health-check the local install: DB exists,
                            permissions, FTS index, audit log, restricted
                            MCP gate, version. Exits non-zero on hard
                            failures, zero on warnings.
  setup [--dry-run] [--force] [--claude-md project|user]
                            One-command bootstrap: register the MCP server
                            with Claude Code, append the retrieval rule to
                            CLAUDE.md, install /loreguard-onboard into
                            ~/.claude/skills/, and nudge you toward the
                            right cold-start ingest (detects CLAUDE.md,
                            AGENTS.md, ADR dirs, top-level docs).
                            Idempotent. Opt out per step with --skip-mcp,
                            --skip-claude-md, --skip-skill,
                            --skip-corpus-nudge.
  demo [--force | --clean]  Seed five illustrative records (tagged 'demo')
                            so you can try list / search / review without
                            authoring content first. Refuses to seed into
                            a non-empty DB unless --force. Use --clean to
                            remove the demo records later.
  induct [--repo <name>] [--short]
                            Repo-onboarding interview: walks you through
                            10 high-signal questions (or 5 with --short)
                            and turns each non-blank answer into a DRAFT
                            lore record (tagged 'induction', 90-day
                            review window). Drafts only — promote via
                            \`loreguard review\`. Use --repo to override the
                            auto-detected name (repeatable).
  absent record "<query>" --reason "..." [--repo X] [--expires-days 14]
                            Record a verified-absence marker: "we
                            checked, the team has no policy on this".
                            When future search_lore returns zero hits
                            on the same normalised query, the response
                            includes this marker so the agent knows
                            it's an acknowledged gap. Self-expires
                            (default 14 days).
  absent list [--include-expired]
                            List active absence markers (or all of
                            them with --include-expired).
  stats [--top N] [--retire] [--since-days N] [--quiet-for-days N] [--json]
                            Local read-tracking view: top-cited
                            records, retirement candidates (active +
                            zero reads in N days), recent activity.
                            Opt out of read tracking via
                            LOREGUARD_NO_TELEMETRY=1.
  prune [--read-events-older-than N] [--vacuum] [--dry-run]
                            Local-DB GC. Deletes 'read' audit events
                            older than N days (default 90; lifecycle
                            events are never touched) and expired
                            absence markers. --vacuum reclaims disk
                            after; --dry-run reports counts only.
  ingest-md <glob>... [--section "Heading"] [--tag X] [--repo Y] [--source URL] [--dry-run] [--include-intent-files]
                            Bulk-import drafts from **clean knowledge
                            docs** (ADRs, SECURITY.md, MIGRATION.md,
                            INTEGRATION_GUIDE.md). NOT for plans /
                            roadmaps / progress trackers — those are
                            skipped by default via filename deny-list
                            (plan/roadmap/progress/todo/backlog/spec/
                            usability/status/execution). Override with
                            --include-intent-files when you mean it.
                            Within allowed files, a content-shape
                            filter rejects TOC bullets, date-stamped
                            status headings, and items with no rule-
                            or fact-markers and a short body. ALWAYS
                            runs --dry-run first to see what survives.
                            For messy repos, use the
                            /loreguard-onboard skill — it uses agent
                            judgement instead of chunking.
  hooks install [--project] [--dry-run]
                            Wire the Claude Code Stop-hook for
                            session-end review nudges. Writes
                            .claude/settings.json so when Claude is
                            about to stop, the hook checks for pending
                            drafts and (once per session) asks the
                            user whether to triage them. Opt-in.
  hooks review-nudge        Internal — invoked by the Stop hook.
                            Reads Claude hook JSON on stdin; emits
                            block-JSON to stdout when drafts are
                            pending and this session hasn't been
                            nudged yet.
  print-claude-instructions
                            Print the retrieval rule to paste into
                            your CLAUDE.md / agent instructions so the
                            agent reliably calls search_lore.
  mcp                       Run the MCP server on stdio (same as loreguard-mcp).

EXAMPLES
  loreguard add --title "Argon2id is the default" --summary "..." --body "..."
  loreguard search "password hashing" --repo payments-svc
  loreguard review
  loreguard approve 7vk3qm9b
`;

async function cmdInit(): Promise<number> {
  const path = defaultDbPath();
  const db = openDb(path);
  db.close();
  // openDb runs migrations and creates the file with 0600 perms.
  process.stdout.write(`loreguard: initialised at ${path}\n`);
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
    process.stderr.write("loreguard: title is required\n");
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
      `loreguard: ${asDraft ? "suggested" : "added"} ${lore.id} (${lore.status})\n`,
    );
    // For drafts (lore suggest), surface near-duplicates so the human
    // reviewing the queue isn't surprised later. Quiet for `loreguard add` —
    // humans entering their own records have already decided.
    //
    // CLI runs locally as the trust principal (the human at the terminal),
    // so restricted records ARE included in the hint list here. The
    // MCP path is different — that's env-gated.
    if (asDraft) {
      const { duplicates } = findPossibleDuplicates(
        db,
        { id: lore.id, title, repos, tags },
        { allowRestricted: true },
      );
      if (duplicates.length > 0) {
        process.stdout.write(
          `Possible duplicates (review with \`loreguard show <id>\`):\n`,
        );
        for (const d of duplicates) {
          const restrictedTag = d.restricted ? " [restricted]" : "";
          process.stdout.write(
            `  ${d.id}  [${d.status}]${restrictedTag}  ${d.title}\n    reason: ${d.reason}\n`,
          );
        }
      }
    }
    return 0;
  } finally {
    db.close();
  }
}

async function cmdSearch(args: ReturnType<typeof parseArgs>): Promise<number> {
  const query = args.positionals.join(" ").trim() || undefined;
  const repo = getString(args.flags, "repo");
  // --tag is repeatable: multiple --tag values become an ANY-of filter.
  const tagList = getStringArray(args.flags, "tag");
  const tag: string | string[] | undefined =
    tagList.length === 0 ? undefined : tagList.length === 1 ? tagList[0] : tagList;
  // Accept either spelling; `--updated-after` is canonical, `--since` is kept
  // as a friendly alias.
  const updatedAfter =
    getString(args.flags, "updated-after") ?? getString(args.flags, "since");
  const limit = parseLimit(getString(args.flags, "limit")) ?? 10;
  const includeDrafts = getBool(args.flags, "include-drafts");
  const includeDeprecated = getBool(args.flags, "include-deprecated");
  const includeSuperseded = getBool(args.flags, "include-superseded");
  const includeRestricted = getBool(args.flags, "include-restricted");
  const prefix = getBool(args.flags, "prefix");
  const db = openDb();
  try {
    const searchOpts = {
      query,
      repo,
      tag,
      prefix,
      updatedAfter,
      limit,
      includeDrafts,
      includeDeprecated,
      includeSuperseded,
      includeRestricted,
    };
    const hits = searchLore(db, searchOpts);
    if (hits.length === 0) {
      process.stdout.write("loreguard: no matches\n");
      return 0;
    }
    for (const h of hits) {
      process.stdout.write(renderSummary(h) + "\n\n");
    }
    // Tell the human when the list was capped so they can narrow or
    // raise --limit rather than assume they've seen everything. Only
    // query the count when we actually hit the cap.
    if (hits.length >= limit) {
      const total = searchLoreCount(db, searchOpts);
      if (total > hits.length) {
        process.stdout.write(
          `loreguard: showing ${hits.length} of ${total} matches — narrow the query, add --repo/--tag, or raise --limit (max 50).\n`,
        );
      }
    }
    return 0;
  } finally {
    db.close();
  }
}

async function cmdShow(args: ReturnType<typeof parseArgs>): Promise<number> {
  const id = args.positionals[0];
  if (!id) {
    process.stderr.write("loreguard: show <id> requires an id\n");
    return 2;
  }
  const db = openDb();
  try {
    const lore = getLore(db, id);
    if (!lore) {
      process.stderr.write(`loreguard: no record with id ${id}\n`);
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
      process.stdout.write("loreguard: nothing here yet — try `loreguard add`.\n");
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
      process.stdout.write("loreguard: no pending drafts.\n");
      return 0;
    }

    // Two modes: default is interactive (per-draft a/r/e/s/q triage).
    // `--list` or non-TTY stdin falls back to the old "print them all" view
    // so `loreguard review | grep` doesn't hang.
    const listOnly =
      getBool(args.flags, "list") || !process.stdin.isTTY;

    if (listOnly) {
      process.stdout.write(`${drafts.length} draft(s) awaiting review:\n\n`);
      for (const d of drafts) process.stdout.write(renderSummary(d) + "\n\n");
      process.stdout.write(
        "Use `loreguard approve <id>` to promote, or `loreguard reject <id>` to drop.\n",
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
        process.stdout.write("\nloreguard: stopped.\n");
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
        // Capture an optional reason so the agent (or future-me) can see
        // *why* a draft was dropped — keeps the feedback loop closed.
        // Blank/whitespace is normalised to "no reason" inside rejectLore.
        const reasonInput = (
          await prompt("  reason (optional, blank to skip): ")
        ).trim();
        const ok = rejectLore(db, d.id, reasonInput || undefined);
        process.stdout.write(
          ok ? `✗ rejected ${d.id}\n\n` : `! could not reject ${d.id}\n\n`,
        );
        if (ok) rejected++;
        continue;
      }
      if (answer === "e" || answer === "edit") {
        // Don't reach for $EDITOR yet — print the update command the user
        // can paste with their preferred shell tooling. Keeps the prompt
        // loop simple; user can come back to `loreguard review` next.
        process.stdout.write(
          `\nTo edit this draft, run:\n` +
            `  loreguard update ${d.id} --summary "..." --body "..."\n` +
            `Then re-run \`loreguard review\` to triage it again.\n\n`,
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
    process.stderr.write("loreguard: reject <id> requires an id\n");
    return 2;
  }
  // getString returns undefined for a bare `--reason` (no value) too,
  // so a missing value can't be silently coerced to the literal "true".
  const reason = getString(args.flags, "reason");
  const db = openDb();
  try {
    const ok = rejectLore(db, id, reason);
    if (!ok) {
      process.stderr.write(
        `loreguard: cannot reject ${id} (unknown id or not a draft; use \`loreguard deprecate\` for active records)\n`,
      );
      return 1;
    }
    process.stdout.write(`loreguard: rejected ${id}\n`);
    return 0;
  } finally {
    db.close();
  }
}

async function cmdApprove(args: ReturnType<typeof parseArgs>): Promise<number> {
  const id = args.positionals[0];
  if (!id) {
    process.stderr.write("loreguard: approve <id> requires an id\n");
    return 2;
  }
  const db = openDb();
  try {
    const lore = approveLore(db, id);
    if (!lore) {
      process.stderr.write(
        `loreguard: ${id} is not a pending draft (already active, deprecated, or unknown)\n`,
      );
      return 1;
    }
    process.stdout.write(`loreguard: approved ${lore.id}\n`);
    return 0;
  } finally {
    db.close();
  }
}

async function cmdDeprecate(args: ReturnType<typeof parseArgs>): Promise<number> {
  const id = args.positionals[0];
  if (!id) {
    process.stderr.write("loreguard: deprecate <id> requires an id\n");
    return 2;
  }
  const db = openDb();
  try {
    const lore = deprecateLore(db, id);
    if (!lore) {
      process.stderr.write(`loreguard: no record with id ${id}\n`);
      return 1;
    }
    process.stdout.write(`loreguard: deprecated ${lore.id}\n`);
    return 0;
  } finally {
    db.close();
  }
}

async function cmdSupersede(args: ReturnType<typeof parseArgs>): Promise<number> {
  const oldId = args.positionals[0];
  const newId = getString(args.flags, "with");
  if (!oldId || !newId) {
    process.stderr.write("loreguard: supersede <old-id> --with <new-id>\n");
    return 2;
  }
  const db = openDb();
  try {
    const lore = supersedeLore(db, oldId, newId);
    if (!lore) {
      process.stderr.write(
        `loreguard: couldn't supersede ${oldId} with ${newId} (check both ids exist and are not the same)\n`,
      );
      return 1;
    }
    process.stdout.write(
      `loreguard: ${oldId} superseded by ${newId}\n`,
    );
    return 0;
  } finally {
    db.close();
  }
}

async function cmdVerify(args: ReturnType<typeof parseArgs>): Promise<number> {
  const id = args.positionals[0];
  if (!id) {
    process.stderr.write("loreguard: verify <id> requires an id\n");
    return 2;
  }
  const reviewAfter = getString(args.flags, "review-after");
  const db = openDb();
  try {
    const lore = verifyLore(db, id, reviewAfter);
    if (!lore) {
      process.stderr.write(`loreguard: no record with id ${id}\n`);
      return 1;
    }
    process.stdout.write(
      `loreguard: verified ${lore.id}` +
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
    process.stderr.write("loreguard: update <id> requires an id\n");
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
      "loreguard: --clear-source conflicts with --source <url>; pick one\n",
    );
    return 2;
  }
  if (clearRepos && reposFlag.length > 0) {
    process.stderr.write(
      "loreguard: --clear-repos conflicts with --repo; pick one\n",
    );
    return 2;
  }
  if (clearTags && tagsFlag.length > 0) {
    process.stderr.write(
      "loreguard: --clear-tags conflicts with --tag; pick one\n",
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
      "loreguard: update needs at least one field flag (--title, --summary, --body, --source, --clear-source, --review-after, --confidence, --team, --repo, --clear-repos, --tag, --clear-tags, --restricted/--unrestricted)\n",
    );
    return 2;
  }

  const db = openDb();
  try {
    const lore = updateLore(db, id, patch as Parameters<typeof updateLore>[2]);
    if (!lore) {
      process.stderr.write(`loreguard: no record with id ${id}\n`);
      return 1;
    }
    process.stdout.write(`loreguard: updated ${lore.id}\n`);
    return 0;
  } finally {
    db.close();
  }
}

async function cmdDelete(args: ReturnType<typeof parseArgs>): Promise<number> {
  const id = args.positionals[0];
  if (!id) {
    process.stderr.write("loreguard: delete <id> requires an id\n");
    return 2;
  }
  const db = openDb();
  try {
    const ok = deleteLore(db, id);
    if (!ok) {
      process.stderr.write(`loreguard: no record with id ${id}\n`);
      return 1;
    }
    process.stdout.write(`loreguard: deleted ${id}\n`);
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
      process.stdout.write("loreguard: no tags yet\n");
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
      process.stdout.write("loreguard: no repos yet\n");
      return 0;
    }
    process.stdout.write(rs.join("\n") + "\n");
    return 0;
  } finally {
    db.close();
  }
}

/**
 * `loreguard sync pull <parent>` — recursively discover every
 * `.loreguard/` directory under `<parent>` and run `importFromDir`
 * on each one. The "one machine, all my repos" cross-repo win: a
 * developer who works in ~/code with N repos that each ship a
 * `.loreguard/` runs this once and their local DB is populated
 * with everything those teams have committed.
 *
 * Bounded scan: skips common heavy directories (`node_modules`,
 * `.git`, `dist`, `build`, `target`, `vendor`, `.next`, `.cache`)
 * to avoid eating the filesystem. Doesn't descend into a discovered
 * `.loreguard/` itself (its contents are the records, not nested
 * caches).
 */
async function cmdSyncPull(
  args: ReturnType<typeof parseArgs>,
  parentDir: string,
): Promise<number> {
  const { resolve } = await import("node:path");
  const absParent = resolve(parentDir);
  if (!existsSync(absParent)) {
    process.stderr.write(
      `loreguard: sync pull — parent directory not found: ${absParent}\n`,
    );
    return 2;
  }
  const found = findLoreguardDirs(absParent);
  if (found.length === 0) {
    process.stdout.write(
      `loreguard: sync pull — no .loreguard/ directories found under ${absParent}\n`,
    );
    return 0;
  }
  const includeRestricted = getBool(args.flags, "include-restricted");
  const force = getBool(args.flags, "force");
  const dryRun = getBool(args.flags, "dry-run");
  const db = openDb();
  let totalCreated = 0;
  let totalUpdated = 0;
  let totalSkippedNewer = 0;
  let totalRejected = 0;
  let totalDangling = 0;
  try {
    process.stdout.write(
      `loreguard: sync pull — found ${found.length} .loreguard/ ${found.length === 1 ? "directory" : "directories"} under ${absParent}\n`,
    );
    for (const d of found) {
      const r = importFromDir(db, d, { includeRestricted, force, dryRun });
      totalCreated += r.created;
      totalUpdated += r.updated;
      totalSkippedNewer += r.skippedNewer;
      totalRejected += r.skipped.length;
      totalDangling += r.danglingSupersededBy.length;
      const verb = r.dryRun ? "would import" : "imported";
      process.stdout.write(
        `  ${d}: ${verb} ${r.created} new + ${r.updated} updated` +
          (r.skippedNewer > 0
            ? `, skipped ${r.skippedNewer} (local newer)`
            : "") +
          (r.skipped.length > 0
            ? `, rejected ${r.skipped.length}`
            : "") +
          "\n",
      );
      if (r.danglingSupersededBy.length > 0) {
        for (const dd of r.danglingSupersededBy) {
          process.stderr.write(
            `    WARNING dangling supersededBy: ${dd.file} ${dd.id} → ${dd.supersededBy}\n`,
          );
        }
      }
    }
    const verb = dryRun ? "would import" : "imported";
    process.stdout.write(
      `\nloreguard: ${verb} ${totalCreated} new + ${totalUpdated} updated across ${found.length} ${found.length === 1 ? "directory" : "directories"}` +
        (totalSkippedNewer > 0
          ? `; ${totalSkippedNewer} skipped as newer locally`
          : "") +
        (totalRejected > 0 ? `; ${totalRejected} rejected` : "") +
        (totalDangling > 0
          ? `; ${totalDangling} dangling supersededBy refs (see warnings)`
          : "") +
        (dryRun ? " (dry-run — no changes written)" : "") +
        "\n",
    );
    return 0;
  } finally {
    db.close();
  }
}

async function cmdSync(args: ReturnType<typeof parseArgs>): Promise<number> {
  const sub = args.positionals[0];
  const dir = args.positionals[1];
  if (sub !== "export" && sub !== "import" && sub !== "pull") {
    process.stderr.write(
      "loreguard: sync requires a subcommand — `loreguard sync export <dir>`, `loreguard sync import <dir>`, or `loreguard sync pull <parent-dir>`\n",
    );
    return 2;
  }
  if (!dir) {
    process.stderr.write(`loreguard: sync ${sub} requires a directory path\n`);
    return 2;
  }
  const includeDrafts = getBool(args.flags, "include-drafts");
  const includeDeprecated = getBool(args.flags, "include-deprecated");
  const includeSuperseded = getBool(args.flags, "include-superseded");
  const includeRestricted = getBool(args.flags, "include-restricted");
  if (sub === "pull") {
    return await cmdSyncPull(args, dir);
  }
  const db = openDb();
  try {
    if (sub === "export") {
      const clean = getBool(args.flags, "clean");
      const r = exportToDir(db, dir, {
        includeDrafts,
        includeDeprecated,
        includeSuperseded,
        includeRestricted,
        clean,
      });
      if (r.removed.length > 0) {
        process.stdout.write(
          `loreguard: removed ${r.removed.length} stale <id>.md file(s) before writing\n`,
        );
      }
      process.stdout.write(
        `loreguard: wrote ${r.written.length} record(s) to ${dir}\n`,
      );
      if (r.restrictedWritten > 0) {
        process.stderr.write(
          `loreguard: WARNING — ${r.restrictedWritten} restricted record(s) written to ${dir}.\n` +
            `  Each file was chmod'd to 0600, but the directory itself is not locked down.\n` +
            `  Do NOT commit these files unless your repo is private and you accept the risk.\n`,
        );
      }
      if (r.excluded.restricted > 0) {
        process.stdout.write(
          `  ${r.excluded.restricted} restricted record(s) held back (pass --include-restricted to include)\n`,
        );
      }
      if (r.excluded.drafts > 0) {
        process.stdout.write(
          `  ${r.excluded.drafts} draft(s) held back (pass --include-drafts to include)\n`,
        );
      }
      return 0;
    }
    // import
    const force = getBool(args.flags, "force");
    const dryRun = getBool(args.flags, "dry-run");
    const r = importFromDir(db, dir, {
      includeRestricted,
      force,
      dryRun,
    });
    const verb = r.dryRun ? "would import" : "imported";
    process.stdout.write(
      `loreguard: ${verb} ${r.created} new + ${r.updated} updated record(s) from ${dir}\n`,
    );
    if (r.skippedNewer > 0) {
      process.stdout.write(
        `  ${r.skippedNewer} record(s) skipped — local copy is newer (pass --force to overwrite)\n`,
      );
    }
    if (r.danglingSupersededBy.length > 0) {
      process.stderr.write(
        `  WARNING — ${r.danglingSupersededBy.length} record(s) reference a supersededBy id that doesn't exist locally:\n`,
      );
      for (const d of r.danglingSupersededBy) {
        process.stderr.write(
          `    ${d.file}: ${d.id} → ${d.supersededBy} (dead reference until the target lands)\n`,
        );
      }
    }
    if (r.skipped.length > 0) {
      process.stdout.write(`  rejected ${r.skipped.length} file(s):\n`);
      for (const s of r.skipped) {
        process.stdout.write(`    ${s.file}: ${s.reason}\n`);
      }
    }
    if (r.dryRun) {
      process.stdout.write(`  (dry-run — no changes written)\n`);
    }
    return 0;
  } finally {
    db.close();
  }
}

async function cmdExport(args: ReturnType<typeof parseArgs>): Promise<number> {
  const out = getString(args.flags, "out");
  const includeDrafts = getBool(args.flags, "include-drafts");
  const includeDeprecated = getBool(args.flags, "include-deprecated");
  const includeSuperseded = getBool(args.flags, "include-superseded");
  const includeRestricted = getBool(args.flags, "include-restricted");
  const db = openDb();
  try {
    const records = exportLore(db, {
      includeDrafts,
      includeDeprecated,
      includeSuperseded,
      includeRestricted,
    });
    const envelope = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      records,
    };
    const json = JSON.stringify(envelope, null, 2) + "\n";
    if (out) {
      writeFileSync(out, json, { encoding: "utf8" });
      try {
        chmodSync(out, 0o600);
      } catch {
        // best-effort: some filesystems (e.g. Windows under WSL) can't chmod
      }
      process.stdout.write(
        `loreguard: exported ${records.length} record(s) to ${out}\n`,
      );
    } else {
      process.stdout.write(json);
    }
    return 0;
  } finally {
    db.close();
  }
}

async function cmdDemo(args: ReturnType<typeof parseArgs>): Promise<number> {
  const force = getBool(args.flags, "force");
  const clean = getBool(args.flags, "clean");
  if (force && clean) {
    process.stderr.write("loreguard: --force and --clean are mutually exclusive\n");
    return 2;
  }
  const db = openDb();
  try {
    if (clean) {
      const removed = cleanDemo(db);
      process.stdout.write(
        removed === 0
          ? "loreguard: no demo records found (nothing to clean)\n"
          : `loreguard: removed ${removed} demo record(s)\n`,
      );
      return 0;
    }
    const existing = countLore(db);
    if (existing > 0 && !force) {
      process.stderr.write(
        `loreguard: refusing to seed demo into a non-empty DB (${existing} record(s) already present).\n` +
          "      Re-run with --force to seed anyway, or `loreguard demo --clean` to remove demo records later.\n",
      );
      return 1;
    }
    const { inserted, ids } = seedDemo(db);
    process.stdout.write(
      `loreguard: seeded ${inserted} demo record(s).\n\n` +
        `Try:\n` +
        `  loreguard list\n` +
        `  loreguard search "timezone"\n` +
        `  loreguard review        # the demo set includes one draft to triage\n\n` +
        `Cleanup when you're done:\n` +
        `  loreguard demo --clean  # removes only records tagged 'demo'\n`,
    );
    // Echo the ids so a curious user can `loreguard show <id>` immediately.
    for (const id of ids) process.stdout.write(`  ${id}\n`);
    return 0;
  } finally {
    db.close();
  }
}

/**
 * Best-effort autodetect of a repo name for the current directory.
 *
 * Order of preference:
 *   1. `git config --get remote.origin.url` parsed to a short name —
 *      this is the most canonical when present (a clone of
 *      `github.com/foo/payments-svc` should tag drafts as
 *      `payments-svc` even if the local folder is `payments-clone`).
 *   2. `basename(process.cwd())` — what the user almost always wants
 *      when they ran `loreguard induct` inside a folder they care
 *      about, with no remote configured (local-only repo, just-init'd
 *      project, monorepo subdir, etc.).
 *
 * Returns `{ name, source }` so the caller can phrase the
 * confirmation prompt honestly ("Detected repo 'foo' from git remote"
 * vs "from current directory"). Returns null only when both fall
 * through (cwd basename is empty / "/" — exceedingly rare).
 */
function detectRepoName(): { name: string; source: "git" | "cwd" } | null {
  try {
    const out = execSync("git config --get remote.origin.url", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    const fromRemote = shortRepoNameFromRemote(out);
    if (fromRemote) return { name: fromRemote, source: "git" };
  } catch {
    // No git repo, no remote, or weird URL — fall through to cwd.
  }
  const fromCwd = basename(process.cwd());
  if (fromCwd && fromCwd !== "/" && fromCwd !== ".") {
    return { name: fromCwd, source: "cwd" };
  }
  return null;
}

async function cmdInduct(args: ReturnType<typeof parseArgs>): Promise<number> {
  // Repo scope. --repo can be passed multiple times. If absent, try to
  // autodetect from git remote, then fall back to the cwd basename,
  // then prompt as a last resort.
  const repoFlags = getStringArray(args.flags, "repo");
  let repos: string[];
  if (repoFlags.length > 0) {
    repos = repoFlags;
  } else {
    const detected = detectRepoName();
    if (detected) {
      const sourceLabel =
        detected.source === "git" ? "git remote" : "current directory";
      const confirm = (
        await prompt(
          `Tag drafts with repo '${detected.name}' (from ${sourceLabel})? [Y/n/type a different name] `,
        )
      ).trim();
      const lower = confirm.toLowerCase();
      if (lower === "n" || lower === "no") {
        repos = [];
      } else if (confirm === "" || lower === "y" || lower === "yes") {
        repos = [detected.name];
      } else {
        // Anything else is treated as an override name.
        repos = [confirm];
      }
    } else {
      const typed = (
        await prompt(
          "Repo name to tag these drafts with (blank to skip): ",
        )
      ).trim();
      repos = typed ? [typed] : [];
    }
  }

  const short = getBool(args.flags, "short");
  const questions = short ? shortInductionQuestions() : INDUCTION_QUESTIONS;

  process.stdout.write(
    `\nlore induct — ${questions.length} questions${short ? " (--short)" : ""}. ` +
      `Answers become DRAFTS (review with \`loreguard review\` afterwards).\n` +
      `Press blank-line to skip a question, type 'q' on the answer line to quit early.\n` +
      (repos.length > 0 ? `Repos: ${repos.join(", ")}\n` : "") +
      `\n`,
  );

  const answers: InductionAnswer[] = [];
  let quitEarly = false;
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!;
    process.stdout.write(
      `── ${i + 1} of ${questions.length} ── ${q.topic} ──\n${q.prompt}\n`,
    );
    const ans = await promptMulti("Answer:");
    const trimmed = ans.trim();
    if (trimmed.toLowerCase() === "q") {
      quitEarly = true;
      break;
    }
    if (trimmed.length === 0) {
      process.stdout.write("(skipped)\n\n");
      continue;
    }
    const source = (
      await prompt("Source URL (PR/ADR/incident, blank to skip): ")
    ).trim();
    answers.push({
      questionKey: q.key,
      answer: trimmed,
      source: source || undefined,
    });
    process.stdout.write("\n");
  }

  const db = openDb();
  try {
    const { created } = runInduct(db, { answers, repos });
    process.stdout.write(
      `\nlore induct: created ${created.length} draft(s)` +
        (quitEarly ? " (quit early — drafts already saved are preserved)" : "") +
        `.\n`,
    );
    for (const c of created) {
      process.stdout.write(`  ${c.id}  ${c.title}\n`);
    }
    if (created.length > 0) {
      process.stdout.write(
        `\nReview them with: loreguard review\n`,
      );
    }
    return 0;
  } finally {
    db.close();
  }
}

async function cmdSetup(args: ReturnType<typeof parseArgs>): Promise<number> {
  const dryRun = getBool(args.flags, "dry-run");
  const force = getBool(args.flags, "force");
  const skipMcp = getBool(args.flags, "skip-mcp");
  const skipClaudeMd = getBool(args.flags, "skip-claude-md");
  const skipSkill = getBool(args.flags, "skip-skill");
  const scopeFlag = getString(args.flags, "claude-md") ?? "project";
  if (scopeFlag !== "project" && scopeFlag !== "user") {
    process.stderr.write(
      `loreguard: --claude-md must be 'project' or 'user' (got '${scopeFlag}')\n`,
    );
    return 2;
  }
  const scope = scopeFlag as ClaudeMdScope;
  const cmPath = claudeMdPath(scope);

  process.stdout.write(
    `loreguard setup${dryRun ? " (dry-run)" : ""}\n` +
      `  claude.md scope: ${scope} (${cmPath})\n\n`,
  );

  // [1/4] MCP server
  if (skipMcp) {
    process.stdout.write("[1/4] MCP server: skipped (--skip-mcp)\n");
  } else if (dryRun) {
    process.stdout.write(
      "[1/4] would run: claude mcp add loreguard loreguard-mcp\n",
    );
  } else {
    const r = addMcpServer();
    if (r.action === "registered") {
      process.stdout.write(
        "[1/4] ✓ registered loreguard MCP server with Claude Code\n",
      );
    } else if (r.action === "already-present") {
      process.stdout.write("[1/4] · MCP server already registered\n");
    } else if (r.action === "claude-cli-missing") {
      process.stdout.write(`[1/4] ! ${r.detail}\n`);
    } else {
      process.stdout.write(`[1/4] ! claude mcp add failed: ${r.detail ?? ""}\n`);
    }
  }

  // [2/4] CLAUDE.md retrieval rule
  if (skipClaudeMd) {
    process.stdout.write("[2/4] CLAUDE.md retrieval rule: skipped (--skip-claude-md)\n");
  } else if (dryRun) {
    process.stdout.write(`[2/4] would append retrieval rule to ${cmPath}\n`);
  } else {
    const r = appendInstructionsToFile(cmPath, force);
    if (r.action === "created") {
      process.stdout.write(`[2/4] ✓ created ${cmPath} with retrieval rule\n`);
    } else if (r.action === "appended") {
      process.stdout.write(`[2/4] ✓ appended retrieval rule to ${cmPath}\n`);
    } else if (r.action === "replaced") {
      process.stdout.write(`[2/4] ✓ replaced existing retrieval block in ${cmPath}\n`);
    } else if (r.action === "already-present") {
      process.stdout.write(`[2/4] · retrieval rule already present in ${cmPath}\n`);
    } else {
      process.stdout.write(
        `[2/4] ! ${cmPath} has a partial loreguard block (only one marker) — re-run with --force to replace\n`,
      );
    }
  }

  // [3/4] /loreguard-onboard skill
  if (skipSkill) {
    process.stdout.write("[3/4] /loreguard-onboard skill: skipped (--skip-skill)\n");
  } else if (dryRun) {
    process.stdout.write(
      `[3/4] would copy skill to ${skillDestPath()}\n`,
    );
  } else {
    try {
      const r = copySkillFile(findBundledSkillPath(), skillDestPath(), force);
      if (r.action === "copied") {
        process.stdout.write(`[3/4] ✓ installed skill at ${r.dest}\n`);
      } else if (r.action === "overwritten") {
        process.stdout.write(`[3/4] ✓ overwrote skill at ${r.dest}\n`);
      } else if (r.action === "already-present") {
        process.stdout.write(`[3/4] · skill already up to date at ${r.dest}\n`);
      } else {
        process.stdout.write(
          `[3/4] ! ${r.dest} exists and differs from bundled — re-run with --force to overwrite\n`,
        );
      }
    } catch (err) {
      process.stdout.write(
        `[3/4] ! ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  // [4/4] cold-start corpus nudge — detect ingestible sources in cwd
  // and recommend the right next step. The MAIN failure mode of day-1
  // is: setup succeeds, first Claude session calls search_lore, gets
  // zero hits, user concludes the tool's broken. The nudge points
  // them at the skill (Claude's reasoning produces better drafts)
  // with the CLI as the bulk-mechanical fallback. We don't *run*
  // ingest here — it requires Claude Code to be active.
  const skipCorpusNudge = getBool(args.flags, "skip-corpus-nudge");
  if (skipCorpusNudge) {
    process.stdout.write("[4/4] cold-start corpus nudge: skipped (--skip-corpus-nudge)\n");
  } else {
    const sources = detectIngestSources();
    const hasAny =
      !!sources.claudeMd ||
      sources.adrDirs.length > 0 ||
      sources.otherDocs.length > 0;
    process.stdout.write("[4/4] Cold-start corpus:\n");
    if (dryRun) {
      if (sources.claudeMd) {
        process.stdout.write(`  would suggest ingesting ${sources.claudeMd}\n`);
      }
      for (const d of sources.adrDirs) {
        process.stdout.write(`  would suggest ingesting ${d}/*.md\n`);
      }
      if (!hasAny) {
        process.stdout.write("  no sources detected\n");
      }
    } else if (hasAny) {
      if (sources.claudeMd) {
        process.stdout.write(`  Found ${sources.claudeMd}\n`);
      }
      if (sources.adrDirs.length > 0) {
        process.stdout.write(
          `  Found ${sources.adrDirs.length} ADR director${sources.adrDirs.length === 1 ? "y" : "ies"}: ${sources.adrDirs.join(", ")}\n`,
        );
      }
      if (sources.otherDocs.length > 0) {
        process.stdout.write(
          `  Found ${sources.otherDocs.length} other top-level doc(s): ${sources.otherDocs.map((p) => p.split("/").pop()).join(", ")}\n`,
        );
      }
      const skillInstalled = !skipSkill;
      process.stdout.write("\n");
      if (skillInstalled) {
        process.stdout.write(
          "  Recommended (uses Claude's reasoning to triage what's worth capturing):\n" +
            "    Open Claude Code in this repo, run /loreguard-onboard\n" +
            "    The skill reads these files and creates well-shaped drafts\n" +
            "    with source citations. Trust gate is unchanged — drafts\n" +
            "    land in `loreguard review`.\n\n" +
            "  Mechanical alternative (CLI, dump-then-prune):\n",
        );
      } else {
        process.stdout.write(
          "  The /loreguard-onboard skill wasn't installed (--skip-skill).\n" +
            "  Cold-start options:\n" +
            "    loreguard induct      # 10-question interview, no Claude needed\n",
        );
      }
      if (sources.claudeMd) {
        process.stdout.write(
          `    loreguard ingest-md ${sources.claudeMd} --section "..."\n`,
        );
      }
      for (const d of sources.adrDirs) {
        process.stdout.write(
          `    loreguard ingest-md ${d}/*.md --tag decisions\n`,
        );
      }
    } else {
      process.stdout.write(
        "  No CLAUDE.md / ADRs / docs detected.\n" +
          "  Bootstrap manually:\n" +
          "    loreguard induct      # 10-question interview\n" +
          "    /loreguard-onboard    # in Claude Code: repo-aware interview\n",
      );
    }
  }

  process.stdout.write(
    "\nDone. After your first ingest, run `loreguard list` to see your drafts.\n",
  );
  return 0;
}

async function cmdDoctor(): Promise<number> {
  const { exitCode, checks } = await runDoctor();
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
    process.env["LOREGUARD_AUDIT_LOG"] ?? join(homedir(), ".loreguard", "audit.jsonl");
  if (!existsSync(path)) {
    process.stdout.write("loreguard: no audit log yet\n");
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
    blocked?: string;
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
    : row.blocked
      ? `→ BLOCKED: ${row.blocked}`
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

async function cmdAbsent(args: ReturnType<typeof parseArgs>): Promise<number> {
  const sub = args.positionals[0];
  if (sub !== "record" && sub !== "list") {
    process.stderr.write(
      "loreguard: absent requires a subcommand — `loreguard absent record \"<query>\" --reason \"...\"` or `loreguard absent list`\n",
    );
    return 2;
  }
  const db = openDb();
  try {
    if (sub === "record") {
      const query = args.positionals[1];
      if (!query) {
        process.stderr.write(
          "loreguard: absent record requires a query (in quotes)\n",
        );
        return 2;
      }
      const reason = getString(args.flags, "reason");
      if (!reason) {
        process.stderr.write(
          "loreguard: absent record requires --reason \"...\" explaining the gap\n",
        );
        return 2;
      }
      const repo = getString(args.flags, "repo");
      const expiresInDaysRaw = getString(args.flags, "expires-days");
      let expiresInDays: number | undefined;
      if (expiresInDaysRaw !== undefined) {
        const n = Number(expiresInDaysRaw);
        if (!Number.isFinite(n) || !Number.isInteger(n)) {
          process.stderr.write(
            `loreguard: --expires-days must be an integer (got ${JSON.stringify(expiresInDaysRaw)})\n`,
          );
          return 2;
        }
        expiresInDays = Math.max(1, Math.min(365, n));
      }
      const result = recordAbsence(db, {
        query,
        reason,
        repo,
        expiresInDays,
        recordedBy: "human",
      });
      process.stdout.write(
        `loreguard: recorded absence marker ${result.id} (expires ${result.expiresAt})\n`,
      );
      // Echo what an active search would surface — useful sanity check.
      const found = findActiveAbsence(db, { query, repo });
      if (found) {
        process.stdout.write(
          `  query normalised to: "${found.query}"${found.repo ? ` (repo: ${found.repo})` : ""}\n`,
        );
      }
      return 0;
    }
    const includeExpired = getBool(args.flags, "include-expired");
    const markers = listAbsences(db, { includeExpired });
    if (markers.length === 0) {
      process.stdout.write(
        includeExpired
          ? "loreguard: no absence markers recorded\n"
          : "loreguard: no active absence markers (pass --include-expired to see aged-out ones)\n",
      );
      return 0;
    }
    for (const m of markers) {
      const scope = m.repo ? ` [${m.repo}]` : "";
      const now = new Date().toISOString();
      const expired = m.expiresAt <= now;
      const flag = expired ? " (expired)" : "";
      process.stdout.write(
        `${m.id}${scope}  "${m.query}"${flag}\n  reason:  ${m.reason}\n  recorded: ${m.recordedAt} by ${m.recordedBy}\n  expires:  ${m.expiresAt}\n\n`,
      );
    }
    return 0;
  } finally {
    db.close();
  }
}

/**
 * `loreguard prune` — local-DB GC. Two leaks accumulate forever without
 * this: `read` audit events (one per search/get result) and expired
 * absence markers. Neither affects correctness (stats windows are
 * bounded; expired markers are already filtered out), but on a busy
 * multi-agent install the row count climbs indefinitely.
 *
 *   --read-events-older-than N   delete 'read' events older than N days
 *                                (default 90 — matches the stats window,
 *                                so nothing stats would show is lost)
 *   --vacuum                     reclaim disk after deletes (VACUUM)
 *   --dry-run                    report what would be deleted, write nothing
 */
async function cmdPrune(args: ReturnType<typeof parseArgs>): Promise<number> {
  const rawDays = getString(args.flags, "read-events-older-than");
  let readDays = 90;
  if (rawDays !== undefined) {
    const n = Number(rawDays);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      process.stderr.write(
        `loreguard prune: --read-events-older-than must be a non-negative integer (got ${JSON.stringify(rawDays)})\n`,
      );
      return 2;
    }
    readDays = n;
  }
  const vacuum = getBool(args.flags, "vacuum");
  const dryRun = getBool(args.flags, "dry-run");

  const db = openDb();
  try {
    if (dryRun) {
      const cutoff = new Date(
        Date.now() - readDays * 86_400_000,
      ).toISOString();
      const reads = (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM events WHERE kind = 'read' AND ts < ?",
          )
          .get(cutoff) as { n: number }
      ).n;
      const markers = (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM absence_markers WHERE expires_at <= ?",
          )
          .get(new Date().toISOString()) as { n: number }
      ).n;
      process.stdout.write(
        `loreguard prune (dry-run):\n` +
          `  would delete ${reads} read event(s) older than ${readDays} days\n` +
          `  would delete ${markers} expired absence marker(s)\n` +
          (vacuum ? `  would VACUUM after deletes\n` : "") +
          `  (dry-run — nothing written)\n`,
      );
      return 0;
    }
    const reads = pruneReadEvents(db, readDays);
    const markers = pruneExpiredAbsences(db);
    process.stdout.write(
      `loreguard prune: deleted ${reads} read event(s) older than ${readDays} days, ${markers} expired absence marker(s)\n`,
    );
    if (vacuum) {
      // VACUUM can't run inside a transaction; openDb doesn't hold one
      // open here. Reclaims pages freed by the deletes above.
      db.exec("VACUUM");
      process.stdout.write("loreguard prune: reclaimed free pages (VACUUM)\n");
    }
    return 0;
  } finally {
    db.close();
  }
}

async function cmdStats(args: ReturnType<typeof parseArgs>): Promise<number> {
  const {
    evidenceForRecord,
    recentActivity,
    renderStatsReport,
    retireCandidates,
    topCitedRecords,
  } = await import("./stats.js");
  // Numeric flags: refuse non-integer input early rather than passing
  // NaN through to better-sqlite3 (which raises an unhelpful "datatype
  // mismatch" deep in the call stack).
  function parseInt1(flag: string, fallback: number): number | null {
    const raw = getString(args.flags, flag);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
      process.stderr.write(
        `loreguard stats: --${flag} must be a positive integer (got ${JSON.stringify(raw)})\n`,
      );
      return null;
    }
    return n;
  }
  const top = parseInt1("top", 10);
  if (top === null) return 2;
  const sinceDays = parseInt1("since-days", 90);
  if (sinceDays === null) return 2;
  const quietForDays = parseInt1("quiet-for-days", 180);
  if (quietForDays === null) return 2;
  const wantsJson = getBool(args.flags, "json");
  const retireOnly = getBool(args.flags, "retire");
  const wantsEvidence = getBool(args.flags, "evidence");
  const evidenceLimit = parseInt1("evidence-top", 5);
  if (evidenceLimit === null) return 2;
  const db = openDb();
  try {
    const retire = retireCandidates(db, { quietForDays });
    if (retireOnly) {
      if (wantsJson) {
        process.stdout.write(JSON.stringify(retire, null, 2) + "\n");
      } else if (retire.length === 0) {
        process.stdout.write("loreguard: no retirement candidates\n");
      } else {
        for (const r of retire) {
          const lastSeen = r.lastReadAt
            ? `last read ${r.lastReadAt.slice(0, 10)}`
            : "never read";
          const src = r.hasSource ? "sourced" : "no source";
          process.stdout.write(
            `${r.id}  ${r.title}  [${r.confidence}, ${src}, ${lastSeen}]\n`,
          );
        }
      }
      return 0;
    }
    const cited = topCitedRecords(db, { sinceDays, limit: top });
    const activity = recentActivity(db, { days: sinceDays });
    // --evidence: pull the actual audit queries that hit each top-cited
    // record. Streamed; safe on large audit logs. Answers "is loreguard
    // earning its keep?" concretely — each top-cited record gets its
    // citation count broken down by the queries that produced it.
    let evidence: Array<{
      id: string;
      rows: Array<{ query: string; tool: string; count: number }>;
      truncated: number;
    }> = [];
    if (wantsEvidence) {
      const auditPath =
        process.env["LOREGUARD_AUDIT_LOG"] ??
        join(homedir(), ".loreguard", "audit.jsonl");
      for (const c of cited) {
        const { rows, truncated } = await evidenceForRecord(auditPath, c.id, {
          sinceDays,
          limit: evidenceLimit,
        });
        evidence.push({ id: c.id, rows, truncated });
      }
    }
    if (wantsJson) {
      const payload: Record<string, unknown> = {
        topCited: cited,
        retireCandidates: retire,
        recentActivity: activity,
      };
      if (wantsEvidence) {
        const byId = new Map(evidence.map((e) => [e.id, e]));
        payload["topCited"] = cited.map((c) => ({
          ...c,
          evidence: byId.get(c.id)?.rows ?? [],
          evidenceTruncated: byId.get(c.id)?.truncated ?? 0,
        }));
      }
      process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    } else {
      process.stdout.write(
        renderStatsReport(cited, retire, activity, { sinceDays, quietForDays }) +
          "\n",
      );
      if (wantsEvidence && cited.length > 0) {
        process.stdout.write("\nEvidence (queries that hit each top record):\n");
        const byId = new Map(evidence.map((e) => [e.id, e]));
        for (const c of cited) {
          const e = byId.get(c.id);
          process.stdout.write(`\n  ${c.id}  ${c.title}\n`);
          if (!e || e.rows.length === 0) {
            process.stdout.write(
              "    (no recorded queries in audit log — reads may pre-date\n" +
                "     read-tracking, or LOREGUARD_NO_TELEMETRY may be set)\n",
            );
            continue;
          }
          for (const r of e.rows) {
            const via = r.tool === "get_lore" ? " (get_lore)" : "";
            process.stdout.write(
              `    ${String(r.count).padStart(4)}× "${r.query}"${via}\n`,
            );
          }
          if (e.truncated > 0) {
            process.stdout.write(
              `         + ${e.truncated} other quer${e.truncated === 1 ? "y" : "ies"}\n`,
            );
          }
        }
      }
    }
    return 0;
  } finally {
    db.close();
  }
}

async function cmdHooks(args: ReturnType<typeof parseArgs>): Promise<number> {
  const sub = args.positionals[0];
  if (sub !== "install" && sub !== "review-nudge") {
    process.stderr.write(
      "loreguard: hooks requires a subcommand — `loreguard hooks install [--project]` or `loreguard hooks review-nudge`\n",
    );
    return 2;
  }
  const {
    decideNudge,
    markSessionNudged,
    mergeHookSettings,
    parseHookInput,
    projectHookSettingsPath,
    readSettingsFile,
    sessionAlreadyNudged,
  } = await import("./hooks.js");
  if (sub === "install") {
    const dryRun = getBool(args.flags, "dry-run");
    const path = projectHookSettingsPath();
    const existing = readSettingsFile(path);
    const next = mergeHookSettings(existing);
    if (existing === next) {
      process.stdout.write(
        `loreguard hooks install: ${path} already contains the loreguard Stop hook (no changes)\n`,
      );
      return 0;
    }
    if (dryRun) {
      process.stdout.write(`--- would write ${path} ---\n`);
      process.stdout.write(next);
      process.stdout.write("--- (dry-run — nothing written) ---\n");
      return 0;
    }
    const { dirname } = await import("node:path");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, next);
    process.stdout.write(
      `loreguard hooks install: wired Stop hook into ${path}\n`,
    );
    return 0;
  }
  // review-nudge: invoked by the Stop hook. Read stdin, check drafts,
  // emit JSON. Never throw — Claude will surface our exit code as a
  // hook failure to the user, which is louder than the bug warrants.
  try {
    const stdin = await readAllStdin();
    const { sessionId } = parseHookInput(stdin);
    const db = openDb();
    try {
      const pending = (
        db.prepare(
          "SELECT COUNT(*) AS n FROM lore WHERE status = 'draft'",
        ).get() as { n: number }
      ).n;
      const nudgeEveryTime =
        process.env["LOREGUARD_REVIEW_NUDGE_EVERY_TIME"] === "1";
      const out = decideNudge({
        pendingDraftCount: pending,
        sessionAlreadyNudged: sessionAlreadyNudged(sessionId),
        nudgeEveryTime,
      });
      if (out.decision === "block") {
        markSessionNudged(sessionId);
        process.stdout.write(JSON.stringify(out));
      }
      // else: silent pass — Claude stops normally.
      return 0;
    } finally {
      db.close();
    }
  } catch (err) {
    // Don't surface — the hook failing should NOT block Claude
    // stopping or break the user's workflow. Log to stderr (Claude
    // shows hook stderr but doesn't interpret it as a block).
    process.stderr.write(
      `loreguard hooks review-nudge: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 0;
  }
}

async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  let buf = "";
  for await (const chunk of process.stdin) buf += chunk;
  return buf;
}

async function cmdIngestMd(
  args: ReturnType<typeof parseArgs>,
): Promise<number> {
  const { globSync } = await import("node:fs");
  const { basename } = await import("node:path");
  const {
    deriveItemSource,
    intentFilenameDenied,
    parseMarkdownItems,
    scoreCandidate,
  } = await import("./ingest.js");
  if (args.positionals.length === 0) {
    process.stderr.write(
      "loreguard: ingest-md requires at least one file/glob argument\n",
    );
    return 2;
  }
  const section = getString(args.flags, "section");
  const extraTags = getStringArray(args.flags, "tag");
  const repoFlags = getStringArray(args.flags, "repo");
  const baseSource = getString(args.flags, "source");
  const dryRun = getBool(args.flags, "dry-run");
  const includeIntentFiles = getBool(args.flags, "include-intent-files");
  // Auto-detect repo if user didn't supply one, matching the induct
  // ladder so a bare `loreguard ingest-md ./CLAUDE.md` Just Works.
  const repos =
    repoFlags.length > 0
      ? repoFlags
      : (() => {
          const det = detectRepoName();
          return det ? [det.name] : [];
        })();
  // Expand the globs.
  const files = new Set<string>();
  for (const pattern of args.positionals) {
    try {
      for (const f of globSync(pattern)) {
        if (typeof f === "string" && f.endsWith(".md")) files.add(f);
      }
    } catch {
      // Treat the literal as a file path if globSync rejects it.
      if (pattern.endsWith(".md") && existsSync(pattern)) files.add(pattern);
    }
  }
  if (files.size === 0) {
    process.stderr.write(
      `loreguard: ingest-md matched 0 markdown files for ${args.positionals.join(" ")}\n`,
    );
    return 1;
  }

  // Diagnostic counters surfaced in --dry-run; tracked always so the
  // final non-dry-run summary can report what was filtered out too.
  let scannedFiles = 0;
  let skippedIntentFiles = 0;
  let chunksEvaluated = 0;
  let drafted = 0;
  const rejectionCounts: Record<string, number> = {};
  function bumpRejection(reason: string): void {
    rejectionCounts[reason] = (rejectionCounts[reason] ?? 0) + 1;
  }

  const db = openDb();
  try {
    for (const file of files) {
      scannedFiles++;
      const fileBase = basename(file).replace(/\.md$/, "");
      const intentMatch = intentFilenameDenied(fileBase);
      if (intentMatch && !includeIntentFiles) {
        skippedIntentFiles++;
        if (dryRun) {
          process.stdout.write(
            `  ${file}: SKIPPED (filename matches deny-list: "${intentMatch}"; pass --include-intent-files to override)\n`,
          );
        }
        continue;
      }
      const text = readFileSync(file, "utf8");
      const items = parseMarkdownItems(text, { section });
      const baseTags = [
        "imported",
        `imported-from:${fileBase}`,
        ...extraTags,
      ];
      let perFileCandidates = 0;
      let perFileRejected = 0;
      for (const item of items) {
        chunksEvaluated++;
        const scoring = scoreCandidate(item);
        if (!scoring.pass) {
          perFileRejected++;
          for (const r of scoring.reasons) bumpRejection(r);
          if (dryRun) {
            process.stdout.write(
              `    REJECT ${file}:L${item.sourceLine}  "${item.title.slice(0, 60)}"  [${scoring.reasons.join("; ")}]\n`,
            );
          }
          continue;
        }
        perFileCandidates++;
        const source = deriveItemSource(baseSource, item.sourceLine);
        if (dryRun) {
          process.stdout.write(
            `    DRAFT  ${file}:L${item.sourceLine}  "${item.title.slice(0, 60)}"  [score=${scoring.score}; ${scoring.reasons.join("; ") || "no markers"}]\n`,
          );
        } else {
          // suggestLore enforces status='draft' regardless of caller —
          // bulk ingest never produces active lore. The reviewer is the
          // gate, as always.
          suggestLore(db, {
            title: item.title,
            summary: item.summary,
            body: item.body,
            tags: baseTags,
            repos: repos.length > 0 ? repos : undefined,
            source,
            // Confidence is clamped to medium on drafts regardless,
            // but pass low when no source so the surface signals it.
            confidence: source ? "medium" : "low",
            author: "ingest-md",
          });
        }
        drafted++;
      }
      if (dryRun) {
        process.stdout.write(
          `  ${file}: ${items.length} chunk(s) → ${perFileCandidates} candidate(s), ${perFileRejected} rejected\n`,
        );
      }
    }
    // Summary — same shape for dry-run and real run.
    const verb = dryRun ? "would draft" : "drafted";
    process.stdout.write(
      `\nloreguard ingest-md: ${verb} ${drafted} record(s) from ${scannedFiles - skippedIntentFiles}/${scannedFiles} file(s)\n`,
    );
    if (skippedIntentFiles > 0) {
      process.stdout.write(
        `  ${skippedIntentFiles} file(s) skipped (filename deny-list — plan/roadmap/progress/etc.; --include-intent-files overrides)\n`,
      );
    }
    if (chunksEvaluated > 0) {
      const rejected = chunksEvaluated - drafted;
      process.stdout.write(
        `  ${chunksEvaluated} chunk(s) evaluated; ${rejected} rejected:\n`,
      );
      const sorted = Object.entries(rejectionCounts).sort(
        (a, b) => b[1] - a[1],
      );
      for (const [reason, n] of sorted) {
        process.stdout.write(`    ${n.toString().padStart(4)}× ${reason}\n`);
      }
    }
    if (dryRun) {
      process.stdout.write(`  (dry-run — nothing written)\n`);
    } else if (drafted > 0) {
      process.stdout.write(
        `  Review the drafts with \`loreguard review\` (or scope: \`loreguard review --tag imported\`).\n`,
      );
    }
    return 0;
  } finally {
    db.close();
  }
}

export async function main(argv: ReadonlyArray<string>): Promise<number> {
  const [, , ...rest] = argv;
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if (rest[0] === "--version" || rest[0] === "-v") {
    // Static for now — populated from package.json at build time later.
    process.stdout.write("0.1.1\n");
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
      case "export":
        return await cmdExport(parsed);
      case "sync":
        return await cmdSync(parsed);
      case "setup":
        return await cmdSetup(parsed);
      case "demo":
        return await cmdDemo(parsed);
      case "induct":
        return await cmdInduct(parsed);
      case "absent":
        return await cmdAbsent(parsed);
      case "stats":
        return await cmdStats(parsed);
      case "prune":
        return await cmdPrune(parsed);
      case "ingest-md":
        return await cmdIngestMd(parsed);
      case "hooks":
        return await cmdHooks(parsed);
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
        process.stderr.write(`loreguard: unknown command '${cmd}'\n${HELP}`);
        return 2;
    }
  } catch (err) {
    process.stderr.write(
      `loreguard: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}
