# loreguard

> **Team-ratified knowledge for AI coding agents.**
> Memory says *what one session believes*; loreguard says *what the team
> has reviewed and approved*.
> Local SQLite-backed MCP server + CLI.

Most agent-memory tools store what an individual session learned. That's
useful, but it's also the failure mode: a confident-sounding agent
recites something it inferred once and got wrong. **Loreguard is the
opposite primitive** — it's the shared record of conventions, decisions,
deprecated patterns, gotchas, and incident lessons that a team has
*ratified*. Agents can suggest; humans approve; the team gets one
trusted record per topic instead of N parallel beliefs.

`CLAUDE.md` is always-on context (every prompt pays for it). **`loreguard`
is just-in-time, team-ratified context** — agents call `search_lore` only
when a task warrants it and get a compact summary of what the team has
already decided, rather than reasoning from scratch.

## Install

> **Not yet on npm.** Until v0.1.0 lands on the registry, install from
> source. The package is ESM, Node 20+, and ships a native SQLite binding
> (`better-sqlite3`) that's built at install time.

```bash
git clone https://github.com/tmj-90/loreguard-mcp.git
cd loreguard-mcp
pnpm install                  # builds the better-sqlite3 native binding too
pnpm build
npm link                      # REQUIRED: puts `loreguard` + `loreguard-mcp` on your $PATH
loreguard init                # creates ~/.loreguard/lore.db (mode 0600)
```

> **The `npm link` step is required.** Without it, typing `loreguard` in your
> terminal will give `command not found`. `npm link` symlinks the local
> `dist/bin/loreguard.js` and `dist/bin/loreguard-mcp.js` into your global npm
> prefix, so `loreguard`, `loreguard-mcp`, `loreguard review`, `loreguard doctor` etc. work
> from any directory just like an npm-installed package would.

Verify it landed:

```bash
which loreguard         # → /opt/homebrew/bin/loreguard  (or wherever your npm prefix is)
loreguard --version     # → 0.1.0
loreguard doctor
```

### One-command bootstrap — `loreguard setup`

Day-to-day use is *ambient* — once Claude Code knows about the
loreguard MCP server and your CLAUDE.md has the retrieval rule, you
just talk to Claude about the repo and it pulls lore automatically. No
slash command, no skill invocation needed.

`loreguard setup` collapses the three "make Claude use it" steps into
one idempotent command:

```bash
loreguard setup                       # project CLAUDE.md (./CLAUDE.md)
loreguard setup --claude-md user      # or user-global ~/.claude/CLAUDE.md
loreguard setup --dry-run             # show what would happen, do nothing
```

What it does:

1. `claude mcp add loreguard loreguard-mcp` (if not already registered).
2. Appends the retrieval rule to `CLAUDE.md` between
   `<!-- loreguard:retrieval-rule begin -->` / `... end -->` markers
   (no-op if already present; safe to re-run after upgrades).
3. Copies the `/loreguard-onboard` skill into
   `~/.claude/skills/loreguard-onboard/SKILL.md`.

Each step is idempotent. `--skip-mcp`, `--skip-claude-md`, `--skip-skill`
opt out individually. `--force` overwrites a drifted retrieval block or
a hand-edited skill.

After this, day-to-day use looks like:

```text
You:   "What's the convention for password hashing here?"
Claude: <calls search_lore("password hashing"); answers from the result>
```

No skill, no slash command, no manual `search_lore` call.

To uninstall the link later:

```bash
cd loreguard-mcp && npm unlink -g
```

Don't want `npm link`? Skip it and reference the absolute path everywhere
(e.g. in `claude mcp add` — see [Hook it up to Claude Code](#hook-it-up-to-claude-code)
below). You won't be able to type `loreguard` directly though; every CLI
invocation becomes `node /absolute/path/to/loreguard-mcp/dist/bin/loreguard.js …`.

Once the package is published on npm this will simplify to:

```bash
npm i -g loreguard-mcp
loreguard init
```

## 5-minute walkthrough

`loreguard demo` seeds five illustrative records (tagged `demo`) so you can
explore the workflow without authoring content first:

```bash
loreguard init
loreguard demo               # five demo records, one of them a draft, one stale
loreguard list               # see what was added
loreguard search timezone    # the dates/timezone gotcha; flagged stale
loreguard search Argon2id    # high-confidence sourced decision
loreguard review             # interactive triage of the draft
loreguard show <id>          # full body of any record
```

When you're done:

```bash
loreguard demo --clean       # removes only records tagged 'demo'
```

`loreguard demo` refuses to seed into a non-empty DB unless you pass
`--force`; `--clean` only deletes demo-tagged rows, so it won't touch
real content.

## Onboard a repo

The demo above ran against a synthetic dataset. Here's the flow for
pointing loreguard at a **real** codebase so agents actually have
useful local memory the next time they touch it:

```bash
cd ~/code/payments-svc

# 1. Cold-start: pick one based on what you have.
loreguard induct                       # 10-Q interview from scratch
# - or - if you already have docs:
loreguard ingest-md ./CLAUDE.md ./docs/adrs/*.md   # one DRAFT per H3 / bullet

# 2. Triage the drafts.
loreguard review                       # [a]pprove / [r]eject / [e]dit / [s]kip / [q]uit

# 3. Teach the agent to actually call search_lore.
loreguard print-claude-instructions >> CLAUDE.md

# 4. (Optional) Commit team lore via PR review.
loreguard sync export .loreguard
git add .loreguard && git commit -m "seed loreguard"

# 5. (Optional) Make sure drafts don't rot.
loreguard hooks install                # opt-in Claude Stop-hook
```

Step 1 is the cold-start — interview from scratch (`induct`) or
bulk-import what you already have (`ingest-md`). They're not mutually
exclusive; many teams do both. Step 2 promotes the keepers. Step 3
wires the agent so it queries lore on the next prompt — without
this, the MCP server is installed but unused. Step 4 is optional and
only matters if you want teammates to pick up the same records via
`loreguard sync import .loreguard`. Step 5 is opt-in: installs a
Claude Stop-hook that nudges you to review pending drafts at session
end so they don't pile up forgotten.

The rest of this section is the detail on each step.

### Step 1 — `loreguard induct` (cold-start interview)

`induct` asks 10 high-signal questions about the things agents tend to
get wrong on a codebase they've never seen:

- dangerous areas to edit without context;
- old patterns that shouldn't be copied;
- architectural decisions that aren't visible from code;
- migrations / transitions in flight;
- invariants that must always hold;
- which tests are authoritative;
- external systems with surprising behaviour;
- non-obvious conventions (naming, timezones, auth, permissions);
- failure modes from past incidents;
- what a new contributor should ask first.

Flag variants:

```bash
loreguard induct                  # autodetects repo name from git remote
loreguard induct --short          # 5 highest-signal questions instead of 10
loreguard induct --repo my-svc    # override the auto-detected name (repeatable)
```

`--short` covers dangerous areas, in-flight migrations, invariants,
non-obvious conventions, and past incidents — the bits agents most
often get wrong first. Use it when inducting your tenth repo; use the
full set the first time.

Every non-blank answer becomes a **DRAFT** record tagged `induction`
with a 90-day `reviewAfter`. Sourced answers go in as `confidence:
medium`; unsourced as `low`. Skip a question with a blank line; quit
early by typing `q` (drafts already saved are preserved).

This is the opposite of "scan repo and invent memory" — it's a
human-driven cold-start. Aim answers at non-obvious, high-consequence
knowledge (see [What deserves lore?](#what-deserves-lore) below);
"we use TypeScript" goes in `CLAUDE.md`, not here.

#### Agent-driven alternative — `/loreguard-onboard` skill

`loreguard induct` works without an agent in the loop — it asks the
same 10 generic questions every time. When you *do* have an agent
available, the bundled **`/loreguard-onboard` Claude skill** does
something better: it reads the repo first (README, ADRs, recent
commits, deprecation markers, in-flight migrations) and surfaces
*repo-specific* candidate drafts grounded in real source citations,
then asks targeted follow-ups instead of the generic 10.

Same trust model — every record still lands as a draft and goes
through `loreguard review`. Install:

```bash
mkdir -p ~/.claude/skills
cp -r skills/loreguard-onboard ~/.claude/skills/
```

Then in Claude Code:

```text
/loreguard-onboard
```

The skill needs the `loreguard-mcp` server already configured (so
`search_lore` / `get_lore` / `suggest_lore` are callable). See
`skills/loreguard-onboard/SKILL.md` for the full procedure.

Use the CLI for offline / scripted cold-starts; use the skill when you
want the agent to do the repo-reading work for you.

#### Bulk-import alternative — `loreguard ingest-md`

> **Caveat: only for clean knowledge docs.** Real-world dogfood
> showed that pointing this at a typical `docs/` directory produces
> 80%+ noise — status trackers, roadmaps, UI specs, and TOC bullets
> all become DRAFT records, the review queue balloons past what any
> human will read, and the trust gate degrades into "approve all."
> The defaults below are tuned to reject that noise hard. If you
> have a *messy* repo (plans / progress trackers mixed with real
> conventions), use the **`/loreguard-onboard` skill** instead — it
> reads files with agent judgement rather than chunking everything.

If you **already have** clean knowledge written down (ADRs,
SECURITY.md as a real policy doc, MIGRATION notes, INTEGRATION
guides) and want to avoid the induct interview's per-question pace,
`loreguard ingest-md` walks a glob, applies two filters, and creates
DRAFT records for what survives. Same `loreguard review` queue gates
everything before promotion.

```bash
# Always start with --dry-run to see what survives the filters.
loreguard ingest-md ./docs/*.md --dry-run

# Then run for real once you trust the output.
loreguard ingest-md ./CLAUDE.md --section "Things That Catch People Out"
loreguard ingest-md ./docs/adrs/*.md --tag decisions
loreguard ingest-md ./docs/*.md --source https://github.com/org/repo
```

**Filter 1: filename deny-list (hard skip).** Files whose name
contains any of `plan`, `roadmap`, `progress`, `todo`, `backlog`,
`spec`, `usability`, `status`, `execution` are skipped entirely.
These shapes are intent / status documents, not durable team
knowledge — they decay fast and pollute FTS with terms agents
shouldn't retrieve. Override with `--include-intent-files` when you
genuinely mean to ingest them.

**Filter 2: content-shape scoring (per chunk).** Each candidate gets
scored:

- **+1** per imperative marker (`must`, `should`, `always`, `never`, `do not`, `prefer`, `avoid`, `required`)
- **+1** per durable-fact marker (`is not` / `are not` / `does not`, `requires` / `require`, `rejects`, `uses`, `stores`, `depends on`, `cannot`, `scoped to`, `contains`, etc.)
- **−1** if body is < 200 chars (short factual lore can still pass on positive markers)
- **−1** per future-tense / planning marker (`will`, `plan to`, `planned:`, `target:`, `todo`, `wip`)

Hard-rejected regardless of score:

- `title === summary === body` (collapsed single-line bullet)
- title contains a date stamp like `(2026-03-24)` (status heading)

Candidates pass at `score >= 0`. The conservative shape means
concise descriptive lore like *"Customer IDs are tenant-scoped"*
passes (fact marker), while a UI spec bullet like *"Cards: Suppliers
Connected: 3/4"* fails (short + no markers).

**Other flags:**

- `--section "Heading Text"` — scope to one heading (case-insensitive substring match); content from that heading until the next same-or-higher-level heading
- `--tag <name>` — extra tag on every drafted record (repeatable; always layered on top of `imported` and `imported-from:<file-basename>`)
- `--repo <name>` — repo scope (repeatable; falls back to the auto-detected name if omitted)
- `--source <url>` — base source URL; if it's a GitHub blob URL, the per-record source becomes `<base>#L<sourceLine>` so the reviewer can jump straight to the right line
- `--dry-run` — print every accept/reject with reasons + summary counters; insert nothing

The three cold-start paths aren't mutually exclusive — many teams do
`ingest-md` on their ADR/policy files for the dense knowledge, then
`induct` or `/loreguard-onboard` for the things that *aren't*
written down yet.

### Step 2 — `loreguard review` (triage drafts)

Drafts are hidden from default search until a human promotes them.
`loreguard review` walks the queue one record at a time with
[a]pprove / [r]eject / [e]dit / [s]kip / [q]uit keystrokes. The same
queue catches both your induction drafts and any drafts agents
suggest later via `suggest_lore` — single triage point, no separate
"agent inbox" to babysit.

When you reject a draft, the interactive flow prompts for an optional
**reason** (`Reason? (optional, blank to skip):`). The reason lands
on the `rejected` event payload, so the agent that suggested it (or
future-you reading the audit chain) can see *why* the draft was
dropped instead of re-suggesting the same shape next session. Closes
the feedback loop without adding a new lifecycle.

For scripted use:

```bash
loreguard approve <id>
loreguard reject <id> --reason "wrong scope — convention is per-repo, not org-wide"
loreguard review --list   # non-interactive overview
```

### Step 3 — wire the agent

Installing the MCP server only exposes the tools; agents won't
actually call `search_lore` until your CLAUDE.md (or Cursor rules /
agent skill) tells them when to. `loreguard print-claude-instructions`
prints a copy-pasteable retrieval rule — append it to whichever file
your agent reads at session start:

```bash
loreguard print-claude-instructions >> CLAUDE.md
```

See [Tell your agent when to use lore](#tell-your-agent-when-to-use-lore)
for the full rule and the rationale.

### Step 4 — (optional) team sync via `.loreguard/`

If you want teammates to share the same lore, commit it to the repo:

```bash
loreguard sync export .loreguard
git add .loreguard && git commit -m "seed loreguard"
```

Teammates run `loreguard sync import .loreguard` to pull it back into
their local SQLite. The PR review is the trust gate — see
[Team sync — Markdown round-trip](#team-sync--markdown-round-trip)
for the full semantics (safe-upsert, `--force`, `--dry-run`, and
what's excluded by default).

### Step 5 — (optional) session-end nudge so drafts don't rot

The hardest failure mode in any team-memory tool isn't capture —
it's the queue of unreviewed drafts that quietly accumulates and
never gets triaged. `loreguard hooks install` wires a Claude Code
**Stop hook** so when Claude is about to end a session it asks
"there are N pending drafts from this session — review now or leave
for later?" once per session.

```bash
loreguard hooks install                # writes .claude/settings.json (project-scope)
loreguard hooks install --dry-run      # preview the merge without writing
```

Behaviour, in plain prose:

- The hook fires on Claude's `Stop` event (session about to end).
- If there are zero pending drafts: silent pass — Claude stops normally.
- If there are drafts and **this session hasn't been nudged yet**:
  emits `{ decision: "block", reason: "There are 2 pending lore
  drafts from this session. Ask the user if they want to run
  `loreguard review` now, or leave them for later. Don't review
  without asking — the user is the gate." }`. Claude surfaces the
  prompt; you decide.
- Already nudged this session? Silent pass. No nag loops.

The per-session "already nudged" state is a zero-byte marker file
under `~/.loreguard/hooks/session-<id>.nudged` (Claude provides
`session_id` in the hook payload). Set
`LOREGUARD_REVIEW_NUDGE_EVERY_TIME=1` to nudge every time instead.

The hook is **opt-in** and **project-scoped** — `loreguard hooks
install` modifies `.claude/settings.json` in the current directory.
If that file has hooks for other tools, they're preserved (the
merge is additive and idempotent — running install twice doesn't
double-add). To turn it off, remove the corresponding `Stop` block
from `.claude/settings.json`.

> **What not to store**
>
> Don't put secrets, credentials, personal data, patient data, or
> anything your AI client should not receive in a prompt into lore.
> `loreguard` is a retrieval index, not a vault — retrieved records are
> sent to your configured LLM provider as part of the next prompt. The
> `restricted` flag hides records from default search and, over MCP,
> blocks direct fetch via `get_lore` unless `LOREGUARD_ALLOW_RESTRICTED_MCP=1`.
> It is still not DLP or a vault: local users can read the DB, and
> once a restricted record is deliberately retrieved it may enter the
> LLM prompt.

## Add a note (human)

Interactively:

```bash
loreguard add
```

Or with flags:

```bash
loreguard add \
  --title "We don't use bcrypt anymore" \
  --summary "Argon2id is the new default after the Platform security review." \
  --body "Reasoning: bcrypt's 72-byte truncation bit us in incident 2025-INC-411. \
Argon2id with m=64MB, t=3, p=4 is the new baseline." \
  --repo payments-svc --repo auth-svc \
  --tag security --tag passwords \
  --team Platform \
  --source https://github.com/org/platform-adrs/pull/14 \
  --confidence high \
  --review-after 2026-03-12
```

Records added by humans default to `status: active` — visible to search.

## What deserves lore?

Lore is most useful when it's small and high-signal. The whole point of
the review-gated draft flow is to keep it that way.

**Good lore:**

- project-specific conventions (style choices baked into one codebase)
- architectural decisions (why this pattern, not that one)
- deprecated patterns (what to use instead, and the source PR)
- migration rules (what changed, and the contract during the cutover)
- recurring gotchas (the bug we keep re-introducing)
- incident lessons (what we learned, link to the write-up)
- security-sensitive coding rules — **excluding secrets**
- cross-repo knowledge that agents repeatedly rediscover

**Bad lore:**

- secrets, credentials, tokens, keys (use a secrets manager)
- personal data, patient data, anything regulated
- transient task state ("the script we ran last Tuesday")
- generic programming advice already known to the model
- unverified agent guesses or session-specific speculation
- facts obvious from a nearby `README.md` or the code itself
- always-on preferences — those belong in `CLAUDE.md`
- anything your AI client should not receive in a prompt

When in doubt, ask: *would a future teammate, six months from now,
thank me for finding this?* If yes, it's lore. If it's a note to
yourself for this afternoon, it isn't.

## Let agents write things down

During a session, Claude can call `suggest_lore` when it discovers something
useful — a convention, a gotcha, a service-specific rule. Suggestions land as
**drafts**: invisible to default search until a human approves them.

```bash
loreguard review            # interactive triage queue:
                       #   [a]pprove  [r]eject  [e]dit  [s]kip  [q]uit
loreguard review --list     # non-interactive list of pending drafts (for piping)
loreguard approve <id>      # promote draft → active
loreguard reject <id>       # drop a draft (refuses non-drafts)
loreguard deprecate <id>    # mark deprecated (still findable with a flag)
loreguard supersede <old> --with <new>
loreguard verify <id>       # bump lastVerifiedAt and clear stale warning
```

`loreguard review` walks each pending draft one at a time so triage is a
keystroke per record. `[e]dit` prints the `loreguard update <id>` template to
copy-paste — keeps the prompt loop simple and avoids reaching for `$EDITOR`.

This is the poisoning-prevention guard: **agents can suggest knowledge, but
only humans (via the CLI) can approve, reject, deprecate, or supersede
records.** The MCP server deliberately exposes no approval tool — agents
cannot promote their own suggestions.

`suggest_lore` also returns up to 3 `possibleDuplicates` (active or draft
records with a similar title, optionally weighted by shared repo/tag) so
the agent can flag near-dupes inline and reviewers spot them at triage.
Each entry includes a `reason` summarising the matched signals
(`similar-title`, `shared-repo:<name>`, `shared-tag:<name>`). Hints only —
suggestions never get blocked.

Restricted records are surfaced as a count (`restrictedDuplicateCount`)
rather than titles, unless `LOREGUARD_ALLOW_RESTRICTED_MCP=1`. Same env gate
as `search_lore` and `get_lore`. `loreguard suggest` from the CLI is local and
shows restricted titles directly with a `[restricted]` marker.

## Search

```bash
loreguard search bcrypt
loreguard search "password hashing" --repo payments-svc
loreguard show <id>
```

CLI search returns the compact `LoreSummary` (no body) by default. `loreguard show`
fetches the full body. Same contract as the MCP tools.

The search payload looks like this — title, summary, scope, trust signals,
no body:

```json
{
  "id": "7vk3qm9b",
  "title": "Argon2id is the password hash default",
  "summary": "Platform security ruling. Bcrypt out.",
  "status": "active",
  "confidence": "high",
  "source": "https://example.com/adrs/14",
  "repos": ["auth-svc", "payments-svc"],
  "tags": ["passwords", "security"],
  "stale": false,
  "updatedAt": "2026-02-10T09:31:00.000Z"
}
```

That's typically 100–200 tokens per hit. The full body lives in
`get_lore({ id })` and is only fetched when the summary isn't enough.
When lore replaces repeated repo exploration or a long pasted
explanation, that adds up — but only with curated, compact records.
Verbose or duplicated lore can grow context, not shrink it.

## Hook it up to Claude Code

If you ran `npm link` above:

```bash
claude mcp add loreguard loreguard-mcp
```

If you didn't, point Claude at the local build directly:

```bash
claude mcp add loreguard node /absolute/path/to/loreguard-mcp/dist/bin/loreguard-mcp.js
```

(Substitute your actual clone path. `claude mcp list` will show the
result.)

Claude sees five tools:

- `search_lore({ query, repo?, tag?, prefix?, updatedAfter?, includeDrafts?, includeDeprecated?, includeSuperseded?, includeRestricted?, limit? })` — returns brief summaries (`tag` accepts a string or `string[]` for ANY-of; `prefix: true` matches 3+ char tokens as prefixes). When the query has **zero hits** and a matching active **absence marker** exists, the response includes `absence_marker: { reason, recordedAt, expiresAt }` so the next agent sees "we checked, known gap" rather than re-discovering nothing. MCP results omit the CLI-only conflict hints: shared repo + tag often means complementary, and surfacing the heuristic to an LLM tends to cost more tokens (the agent treats it as authority and tries to "resolve" false alarms) than the heuristic earns. `loreguard search` still shows them for human triage.
- `get_lore({ id })` — full body of one record.
- `suggest_lore({ title, summary, body, repos?, tags?, source?, confidence?, team? })` — agent creates a draft; response includes `{ id, status, message, possibleDuplicates, restrictedDuplicateCount }` (up to 3 similar non-restricted records with a `reason` signal summary, plus a redacted count for matching restricted records — hints only, never blocks). Over-cap inputs (`title > 200`, `summary > 800`) return a **structured error** `{ error: "summary_too_long" | "title_too_long", provided, max, suggested_cut, hint }` instead of failing through zod's max-cap path — the agent can paste `suggested_cut` back as a corrected retry without a human round-trip. Body length is intentionally uncapped (body is fetched on demand via `get_lore`, not returned in search hits).
- `report_conflict({ existingId, observation, source?, repos?, tags? })` — agent has found code (or other evidence) that contradicts an existing **active** record. Creates a DRAFT counter-record tagged `conflict-report`, linked back via `conflictsWith: [existingId]`, surfaced in the normal `loreguard review` queue. The original record is **never mutated** — the link is one-way; the reviewer resolves via `loreguard supersede` / `loreguard update` / `loreguard reject` against the counter. **Restricted existing records are unconditionally refused** — agents can read restricted records (when `LOREGUARD_ALLOW_RESTRICTED_MCP=1`) but can never draft counter-records against them; surface the concern to the human and let them revise via the CLI. See [`docs/adr/ADR-003-conflict-records-shape.md`](docs/adr/ADR-003-conflict-records-shape.md) for the storage-shape rationale.
- `record_absence({ query, reason, repo?, expiresInDays? })` — agent searched, found nothing, AND has confirmed the gap is real and durable (not just a phrasing miss). Records a **self-expiring** marker (default 14 days; max 365) so the next `search_lore` on the same normalised query surfaces `absence_marker: { reason, ... }` instead of returning empty again. **MCP access is off by default in v0.1** (`LOREGUARD_ALLOW_MCP_ABSENCE=1` to enable); the CLI `loreguard absent record` always works, so the default flow is "agent surfaces the gap → human records the marker." When enabled: **don't auto-call this on every zero-hit search** — only when the absence is itself the finding. No review gate when MCP writes are enabled (low-stakes, time-bounded — distinct from drafts). Markers are normalised order-independently and case-insensitively so `"payments-svc retry policy"` and `"Retry POLICY payments-svc"` share a marker. Repo-scoped markers shadow global ones when the search is also repo-scoped.

The MCP surface is intentionally narrow. Agents can read, suggest,
challenge, and flag known gaps; **approval, deprecation, and
supersession are CLI-only**.

## Tell your agent when to use lore

Installing the MCP server only exposes the tools. To make agents use them
consistently, add a short retrieval rule to your agent instructions
(`CLAUDE.md`, Cursor rules, your coding skill, etc.):

```md
Before non-trivial or context-sensitive code changes, search `lore` for
relevant local memory.

Search when the task touches:
- auth/security
- dates/timezones
- migrations/schema changes
- payments/billing
- API contracts
- deployment/infra
- cross-repo conventions
- unfamiliar services or subsystems

Call `search_lore` first with the repo name, subsystem, and kind of change.
Prefer records that are `active`, scoped to the current repo/team/tag,
not stale, medium/high confidence, and backed by a source.

Treat stale, low-confidence, source-less, deprecated, or conflicting
records as clues, not authority. If lore conflicts with the repo, tests,
or the user's explicit instruction, surface the conflict before proceeding.

Only call `get_lore` when the summary is not enough.

At the end of the task, call `suggest_lore` only if you discovered a
reusable convention, gotcha, decision, or service-specific rule that
would help future agents. Do not save temporary task state or speculation.
```

## Why not just CLAUDE.md? And why not generic agent memory?

Three things that look similar but are not:

| | What it is | What it's for | Trust source |
|---|---|---|---|
| `CLAUDE.md` | Always-on instructions, paid for on every prompt | Rules that apply *every* session — code style, language conventions, what to grep first | You wrote it; it lives in your repo |
| Generic agent memory | Cross-session recall of *what one session inferred* | Personal continuity ("remember I prefer X") | A single session believed it |
| `loreguard` | On-demand retrieval of *what the team has reviewed and approved* | Repo-specific decisions, gotchas, migrations, incident lessons | A human ratified it via `loreguard review` |

Generic memory tracks **what I believe**. Loreguard tracks **what the team
has ratified**. Both can store the sentence "Use Argon2id, not bcrypt" —
the difference is whether a future agent should trust it without
checking, and whether two agents working in parallel will see the same
answer. Memory says yes-and-yes-but-only-for-this-session; loreguard
says yes-and-everywhere, because a human reviewed it and approved it.

That distinction matters when there's *disagreement*: if memory says X
and the code says NOT X, the agent has no anchor. If loreguard says X
and the code says NOT X, the agent has a ratified record to flag the
conflict against — and a path (`suggest_lore`, then human review) to
update the team record if the code is right.

Rule of thumb: if a fact applies every session, put it in `CLAUDE.md`. If
it's an individual preference for one user, put it in your agent's
memory. If a *team* should agree on it across N repos and M agent
sessions, put it in loreguard.

## Trust model

Every record carries lifecycle + provenance metadata so retrieval is honest:

| Field | Meaning |
|-------|---------|
| `status` | `draft` (agent, awaiting review), `active` (canonical), `deprecated`, `superseded` |
| `source` | URL: PR / ADR / incident / ticket. Records without a source are lower-trust. |
| `confidence` | `low` \| `medium` \| `high`. Default `medium`. *Agent-suggested records cannot claim `high`. Records without a `source` cannot be `high` — invariant enforced at write time.* |
| `reviewAfter` | ISO date; if past, search flags `stale: true`. |
| `supersededBy` | ID of the record that replaces this one. |
| `restricted` | Excluded from search unless `includeRestricted: true`. Via MCP, both `search_lore` and `get_lore` are env-gated by `LOREGUARD_ALLOW_RESTRICTED_MCP`; with the gate off, `get_lore` of a restricted id returns a minimal refusal (no title/body). |
| `lastVerifiedAt` | Bumped by `loreguard verify <id>`. |

`restricted` is a **retrieval guard**, not a data-loss-prevention mechanism.
Use it to hide a record from a casual search, not to keep secrets out of an
LLM prompt — once retrieved, the content is in the agent's context.

## Where data lives

A single SQLite file at `~/.loreguard/lore.db` (mode `0600`). That's the entire
storage layer.

**For v0.1, SQLite is the canonical source of truth.** Markdown files
under `.loreguard/` are a *sync artifact*: PR-reviewable, committable to the
repo, and round-trippable with `loreguard sync`, but the live record lives
in SQLite. Drop one machine's DB and rebuild it by importing your
team's `.loreguard/` directory.

Override the path with `LOREGUARD_DB=/some/other.db` for tests or alternate
profiles.

**Environment knobs** (all local-only — none reach the network):

| Var | Effect |
|---|---|
| `LOREGUARD_DB` | Override the SQLite path (default `~/.loreguard/lore.db`). |
| `LOREGUARD_AUDIT_LOG` | Override the audit log path (default `~/.loreguard/audit.jsonl`). |
| `LOREGUARD_AUDIT_OFF=1` | Silence both the MCP audit log AND `read` event tracking. The test suite sets this. |
| `LOREGUARD_NO_TELEMETRY=1` | Silence `read` event tracking only (audit log still records MCP tool calls). The "I just don't want stats counters" toggle. |
| `LOREGUARD_ALLOW_RESTRICTED_MCP=1` | Let MCP `search_lore` / `get_lore` see restricted records. Off by default. `report_conflict` is unconditionally refused on restricted records regardless of this flag — agents can read but not challenge them. |
| `LOREGUARD_ALLOW_MCP_ABSENCE=1` | Let MCP agents write absence markers via `record_absence`. Off by default in v0.1 — the CLI `loreguard absent record` is the only path until you opt in. Markers are low-stakes (self-expiring, never appear as canonical lore) but this is still an agent-writable retrieval modifier, so v0.1 ships it opt-in. |

### Team sync — Markdown round-trip

`loreguard sync export <dir>` writes one `.md` file per record into `<dir>`
(typically `.loreguard/` in the repo). `loreguard sync import <dir>` is the
inverse — new and updated `.md` files are merged back in by id, but a
strictly newer local record is never silently clobbered. Combined with
normal git workflow, the PR review *is* the trust gate: a record in
`.loreguard/` got there through code review.

```bash
loreguard sync export .loreguard               # active + non-restricted by default
loreguard sync export .loreguard --include-deprecated --include-superseded
loreguard sync export .loreguard --clean       # remove stale <id>.md files first
loreguard sync import .loreguard               # safe-import: skips local records that are newer
loreguard sync import .loreguard --force        # overwrite local records even when newer
loreguard sync import .loreguard --dry-run      # preview what would change
loreguard sync import .loreguard --include-restricted
```

Each `.md` is YAML-frontmatter + Markdown body. Frontmatter is
deterministic (fixed field order) so re-exporting a clean DB produces
byte-identical files — your diffs stay tight.

Defaults are conservative:

- **Restricted records are excluded** from export by default. Committing
  restricted titles to git is usually a mistake; if your repo is private
  and you want the history, pass `--include-restricted`.
- **Drafts are excluded** from export by default. They haven't been
  reviewed yet; `loreguard review` is the gate, not `git push`.
- **Imports respect the file's declared `status`.** If a `.md` says
  `status: active`, it lands as active — the PR is the review gate.
  Restricted-record files are skipped on import unless
  `--include-restricted` is set.
- Files without frontmatter, or missing required fields (`id`, `title`,
  `summary`, `status`), are skipped with a reason — `loreguard sync import`
  never crashes on a malformed file.

A few things `loreguard sync` deliberately does **not** do:

- **`loreguard sync export` is not a mirror.** It overwrites the `<id>.md`
  files for records being exported, but does not remove `.md` files
  that have no corresponding record. Pass `--clean` if you want a
  deterministic mirror; otherwise, clear the directory first.
- **`loreguard sync import` is safe-upsert.** It creates new records and
  updates existing ones by id, but does **not** overwrite a local
  record whose `updatedAt` is strictly newer than the incoming file's
  — pass `--force` to override. It does **not** delete local records
  that are absent from the directory either; if your team has removed
  a record from `.loreguard/`, use `loreguard delete <id>` locally as
  well. Use `--dry-run` to preview the import plan before writing.
- **The frontmatter parser is intentionally small** — flat scalars,
  ISO dates, booleans, and string arrays only. Treat the generated
  format as canonical; if you hand-edit a `.md`, keep the structure
  the same.

`loreguard export --json` still exists for one-file JSON backup and
inspection; `loreguard sync` is for the version-controlled team flow.

### Verified-absence markers

A recurring waste in agent workflows is **re-discovering the same
nothing across sessions**: agent searches for "payments-svc retry
policy", gets zero hits, reasons from scratch; next session a
different agent does the same search, gets the same zero hits,
reasons from scratch again. There's no record that "we checked here,
the team has no policy on this — don't re-search for 14 days."

`loreguard absent` records that signal:

```bash
loreguard absent record "payments-svc retry policy" --reason "team has no policy yet; ad hoc per incident"
loreguard absent record "auth/sso" --reason "covered by platform's IdP, no app-side policy" --repo payments-svc
loreguard absent list                       # active markers
loreguard absent list --include-expired     # everything including aged-out
```

> **MCP-side `record_absence` is off by default** because it writes
> retrieval-affecting state without human review. The CLI
> `loreguard absent record` is the v0.1 default path — agents
> surface the gap, humans record the marker. To let agents write
> markers directly, the operator sets `LOREGUARD_ALLOW_MCP_ABSENCE=1`
> in the MCP server's environment.

When MCP writes are enabled, the companion is `record_absence({ query,
reason, repo?, expiresInDays? })` — agents call it when they've
searched, found nothing, *and* are confident the gap is real. After
that, the next `search_lore` on the same normalised query surfaces
the marker so the next agent knows it's an acknowledged gap rather
than an oversight.

**Markers self-expire** (default 14 days, max 365). Stale "we
checked" claims age out automatically rather than becoming permanent
dead-end annotations. Once MCP writes are enabled there's no review
gate (low-stakes, time-bounded, distinct from drafts) — that's the
whole reason the gate exists at the MCP layer. Query normalisation
is order-independent and case-insensitive: `"retry policy
payments-svc"` and `"payments-svc Retry POLICY"` share a marker, but
`"backoff strategy"` is a separate (deliberately unsynonymised) gap.

### Stats — local read tracking

`loreguard stats` answers "is loreguard earning its keep?" without
sending anything off-box. Three views, all aggregate-only against
the existing `events` table (no new schema, no telemetry endpoint):

```bash
loreguard stats                       # top-cited + retire candidates + recent activity
loreguard stats --top 20              # broader top-cited list
loreguard stats --retire              # retirement-candidate list only
loreguard stats --since-days 30       # window override for top + activity
loreguard stats --quiet-for-days 90   # window for retire-candidate detection
loreguard stats --json                # machine-readable output for piping
```

- **Top-cited records** — sorted by `read` event count in the last
  N days. A `read` event is emitted by `searchLore` (one per hit)
  and `getLore` (one per fetch). Records that have been hard-deleted
  are excluded so phantom counts don't pollute the leaderboard.
- **Retirement candidates** — active records with **zero reads in the
  past N days** (default 180). Sort key surfaces the cheapest-to-retire
  first: no-source records before sourced, ascending confidence (low →
  medium → high), then oldest `updated_at`.
- **Recent activity** — event-kind histogram for the window:
  `suggested / approved / rejected / deprecated / superseded /
  updated / reads / imports`.

**Local-only by construction.** Read tracking writes to your SQLite
`events` table on the same machine — *no data leaves the box*. The
"telemetry" word in the env var name is historical; this is just
local counters, not outbound telemetry. To turn it off entirely,
set `LOREGUARD_NO_TELEMETRY=1` (the dedicated off-switch) or the
broader `LOREGUARD_AUDIT_OFF=1` (which silences both MCP audit and
read events — the test suite uses this to keep counters clean).
`loreguard doctor` surfaces whether tracking is on or off so you
can confirm at a glance.

> Read events record `lore_id` + `kind: 'read'` + `ts` only. Not the
> query, not the calling agent, not who you are. The audit log
> (separate, `~/.loreguard/audit.jsonl`) records MCP tool calls and
> may include search-query text — that's the lever for understanding
> *what was asked*; `events` is the lever for *which records pulled
> weight*. Both stay local.

### Inspect / back up your lore

`loreguard export` writes the DB as a single JSON document so you can read,
diff, copy, or pipe it without touching SQLite directly:

```bash
loreguard export                              # stdout, active + non-restricted
loreguard export --out lore-backup.json       # file (mode 0600)
loreguard export --include-drafts --include-deprecated --include-superseded --include-restricted --out full.json
```

Envelope: `{ schemaVersion: 1, exportedAt, records: [Lore, ...] }`. Stable
ordering by `updatedAt desc` with an `id asc` tiebreak — two exports of
the same DB diff cleanly.

## Security

See [`docs/SECURITY.md`](docs/SECURITY.md) and [`docs/DATA-FLOW.md`](docs/DATA-FLOW.md).

**`loreguard` protects against:**

- Accidental over-sharing (drafts hidden by default; `restricted` excluded by default; both MCP `search_lore` and `get_lore` env-gated for restricted records).
- Stale or unreviewed memory dominating retrieval (`stale: true` flag; lifecycle filtering; agent suggestions land as drafts).
- Audit-log leakage of body content (sanitised pre-write; `loreguard audit` renders redacted by default).

> **What the audit log DOES contain** (always local — `~/.loreguard/audit.jsonl`,
> mode 0600): MCP tool name, search-query text, suggested record's
> title (not summary or body), `source` URL, length-only counts for
> larger fields, redacted display in `loreguard audit`. Read tracking
> (`events` table) is separate and contains lore_id + 'read' + ts
> only — no query, no agent identity. Disable either via env vars
> (`LOREGUARD_AUDIT_OFF=1`, `LOREGUARD_NO_TELEMETRY=1`); see [Where
> data lives](#where-data-lives) for the full knob list.

**`loreguard` does not protect against:**

- A malicious local user with filesystem access. The DB is mode 0600 but anyone who can read it can read every record.
- Secrets intentionally added to lore. Use a secrets manager; `restricted` is a retrieval guard, not a vault.
- An LLM provider seeing content the agent has retrieved. That's the standard trust boundary you already accept for any AI tool use.
- Compromise of the MCP client or shell environment.

Short version:

- The server uses stdio transport only. No network listener, ever.
- The `loreguard` application code uses stdio transport only and makes no outbound HTTP calls. The MCP SDK dependency includes unused HTTP/client modules; `loreguard` does not import or configure them. No telemetry or analytics SDKs.
- The DB file is local, mode 0600, in your home directory.
- Audit log at `~/.loreguard/audit.jsonl`: every **MCP tool call** timestamped (with request args and result IDs, never result bodies). CLI mutations are recorded separately in the SQLite `events` table (`created`, `suggested`, `approved`, `deprecated`, `superseded`, `verified`, `updated`, `deleted`) keyed by lore id.

Data does leave your machine the moment Claude reads a tool result — it goes
to your LLM provider as part of the next prompt. That's the standard trust
boundary you already accept for any AI tool use. For enterprise, use your
provider's Zero Data Retention plan.

## License

MIT.
