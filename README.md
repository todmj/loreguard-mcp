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
git clone https://github.com/todmj/loreguard-mcp.git
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

# 1. Cold-start: 10-question interview that turns answers into DRAFT lore.
loreguard induct                  # use --short for the 5-question version

# 2. Triage the drafts you just created.
loreguard review                  # [a]pprove / [r]eject / [e]dit / [s]kip / [q]uit

# 3. Teach the agent to actually call search_lore.
loreguard print-claude-instructions >> CLAUDE.md

# 4. (Optional) Commit team lore via PR review.
loreguard sync export .loreguard
git add .loreguard && git commit -m "seed loreguard"
```

Steps 1–2 are the human-driven cold-start: you answer questions, then
promote the keepers. Step 3 wires the agent so it queries lore on the
next prompt — without this, the MCP server is installed but unused.
Step 4 is optional and only matters if you want teammates to pick up
the same records via `loreguard sync import .loreguard`.

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

### Step 2 — `loreguard review` (triage drafts)

Drafts are hidden from default search until a human promotes them.
`loreguard review` walks the queue one record at a time with
[a]pprove / [r]eject / [e]dit / [s]kip / [q]uit keystrokes. The same
queue catches both your induction drafts and any drafts agents
suggest later via `suggest_lore` — single triage point, no separate
"agent inbox" to babysit.

For scripted use: `loreguard approve <id>` and `loreguard reject <id>`.
For a quick non-interactive list: `loreguard review --list`.

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

Claude sees three tools:

- `search_lore({ query, repo?, tag?, prefix?, updatedAfter?, includeDrafts?, includeDeprecated?, includeSuperseded?, includeRestricted?, limit? })` — returns brief summaries (`tag` accepts a string or `string[]` for ANY-of; `prefix: true` matches 3+ char tokens as prefixes). MCP results omit the CLI-only conflict hints: shared repo + tag often means complementary, and surfacing the heuristic to an LLM tends to cost more tokens (the agent treats it as authority and tries to "resolve" false alarms) than the heuristic earns. `loreguard search` still shows them for human triage.
- `get_lore({ id })` — full body of one record
- `suggest_lore({ title, summary, body, repos?, tags?, source?, confidence?, team? })` — agent creates a draft; response includes `{ id, status, message, possibleDuplicates, restrictedDuplicateCount }` (up to 3 similar non-restricted records with a `reason` signal summary, plus a redacted count for matching restricted records — hints only, never blocks)

The MCP surface is intentionally narrow. Agents can read and suggest;
**approval, deprecation, and supersession are CLI-only**.

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
