# lore

> **Reviewed project memory for coding agents.**
> Agents can suggest reusable project knowledge; humans decide what
> becomes trusted lore.
> Local SQLite-backed MCP server + CLI.

Every AI coding session starts cold. Agents re-read the same files, rediscover
the same conventions, and burn tokens on context you already taught them last
week. `lore` gives them a local memory: record the important bit once, then
retrieve only the short version when it matters.

`CLAUDE.md` is always-on context (every prompt pays for it). **`lore` is
just-in-time context** — agents call `search_lore` only when a task warrants
it, and get a compact summary back. Full body only on demand.

## Install

> **Not yet on npm.** Until v0.1.0 lands on the registry, install from
> source. The package is ESM, Node 20+, and ships a native SQLite binding
> (`better-sqlite3`) that's built at install time.

```bash
git clone https://github.com/todmj/lore-mcp.git
cd lore-mcp
pnpm install                  # builds the better-sqlite3 native binding too
pnpm build
npm link                      # REQUIRED: puts `lore` + `lore-mcp` on your $PATH
lore init                     # creates ~/.lore/lore.db (mode 0600)
```

> **The `npm link` step is required.** Without it, typing `lore` in your
> terminal will give `command not found`. `npm link` symlinks the local
> `dist/bin/lore.js` and `dist/bin/lore-mcp.js` into your global npm
> prefix, so `lore`, `lore-mcp`, `lore review`, `lore doctor` etc. work
> from any directory just like an npm-installed package would.

Verify it landed:

```bash
which lore         # → /opt/homebrew/bin/lore  (or wherever your npm prefix is)
lore --version     # → 0.1.0
lore doctor
```

To uninstall the link later:

```bash
cd lore-mcp && npm unlink -g
```

Don't want `npm link`? Skip it and reference the absolute path everywhere
(e.g. in `claude mcp add` — see [Hook it up to Claude Code](#hook-it-up-to-claude-code)
below). You won't be able to type `lore` directly though; every CLI
invocation becomes `node /absolute/path/to/lore-mcp/dist/bin/lore.js …`.

Once the package is published on npm this will simplify to:

```bash
npm i -g lore-mcp
lore init
```

## 5-minute walkthrough

`lore demo` seeds five illustrative records (tagged `demo`) so you can
explore the workflow without authoring content first:

```bash
lore init
lore demo               # five demo records, one of them a draft, one stale
lore list               # see what was added
lore search timezone    # the dates/timezone gotcha; flagged stale
lore search Argon2id    # high-confidence sourced decision
lore review             # interactive triage of the draft
lore show <id>          # full body of any record
```

When you're done:

```bash
lore demo --clean       # removes only records tagged 'demo'
```

`lore demo` refuses to seed into a non-empty DB unless you pass
`--force`; `--clean` only deletes demo-tagged rows, so it won't touch
real content.

## Onboarding a repo: `lore induct`

`lore demo` shows the *workflow*; `lore induct` helps you generate
*real* starting lore for a specific repo. It's a short interactive
interview — 10 high-signal questions about the things agents tend to
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

```bash
cd ~/code/payments-svc
lore induct                  # autodetects repo name from git remote
lore induct --short          # 5 highest-signal questions instead of 10
lore induct --repo my-svc    # set the repo explicitly (repeatable)
```

`--short` covers dangerous areas, in-flight migrations, invariants,
non-obvious conventions, and past incidents — the bits agents most
often get wrong first. Use it when inducting your tenth repo; use the
full set the first time.

Every non-blank answer becomes a **DRAFT** record tagged `induction`
with a 90-day `reviewAfter`. Sourced answers go in as `confidence:
medium`; unsourced as `low`. Promote what's worth keeping via
`lore review` — same triage queue agents' suggestions flow through.
Skip a question with a blank line; quit early by typing `q` (drafts
already saved are preserved).

This is the opposite of "scan repo and invent memory" — it's a
human-driven cold-start. Aim answers at non-obvious, high-consequence
knowledge (see [What deserves lore?](#what-deserves-lore) above);
"we use TypeScript" goes in `CLAUDE.md`, not here.

> **What not to store**
>
> Don't put secrets, credentials, personal data, patient data, or
> anything your AI client should not receive in a prompt into lore.
> `lore` is a retrieval index, not a vault — retrieved records are sent
> to your configured LLM provider as part of the next prompt. The
> `restricted` flag hides records from default search and, over MCP,
> blocks direct fetch via `get_lore` unless `LORE_ALLOW_RESTRICTED_MCP=1`.
> It is still not DLP or a vault: local users can read the DB, and
> once a restricted record is deliberately retrieved it may enter the
> LLM prompt.

## Add a note (human)

Interactively:

```bash
lore add
```

Or with flags:

```bash
lore add \
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
lore review            # interactive triage queue:
                       #   [a]pprove  [r]eject  [e]dit  [s]kip  [q]uit
lore review --list     # non-interactive list of pending drafts (for piping)
lore approve <id>      # promote draft → active
lore reject <id>       # drop a draft (refuses non-drafts)
lore deprecate <id>    # mark deprecated (still findable with a flag)
lore supersede <old> --with <new>
lore verify <id>       # bump lastVerifiedAt and clear stale warning
```

`lore review` walks each pending draft one at a time so triage is a
keystroke per record. `[e]dit` prints the `lore update <id>` template to
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
rather than titles, unless `LORE_ALLOW_RESTRICTED_MCP=1`. Same env gate
as `search_lore` and `get_lore`. `lore suggest` from the CLI is local and
shows restricted titles directly with a `[restricted]` marker.

## Search

```bash
lore search bcrypt
lore search "password hashing" --repo payments-svc
lore show <id>
```

CLI search returns the compact `LoreSummary` (no body) by default. `lore show`
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
claude mcp add lore lore-mcp
```

If you didn't, point Claude at the local build directly:

```bash
claude mcp add lore node /absolute/path/to/lore-mcp/dist/bin/lore-mcp.js
```

(Substitute your actual clone path. `claude mcp list` will show the
result.)

Claude sees three tools:

- `search_lore({ query, repo?, tag?, updatedAfter?, includeDrafts?, includeDeprecated?, includeSuperseded?, includeRestricted?, limit? })` — returns brief summaries
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

## Why not just CLAUDE.md?

Use `CLAUDE.md` for **always-on** rules the agent should see every session
— code style, the language you're working in, what to grep for first.
That context is paid for on every prompt.

Use `lore` for **just-in-time** context that's only relevant sometimes:
repo conventions, service gotchas, incident lessons, migration rules,
security decisions, cross-repo knowledge. The agent calls `search_lore`
only when the task warrants it and gets a compact summary back. Full
body only on demand via `get_lore`. The primary promise is correctness
(reviewed knowledge, trust signals, no agent-promoted memory); reduced
repeated context loading is a consequence — real when records stay
short and high-signal, lost when they don't.

If a rule applies to every session, it belongs in `CLAUDE.md`. If it
applies only when you're touching `payments-svc`, it belongs in `lore`.

## Trust model

Every record carries lifecycle + provenance metadata so retrieval is honest:

| Field | Meaning |
|-------|---------|
| `status` | `draft` (agent, awaiting review), `active` (canonical), `deprecated`, `superseded` |
| `source` | URL: PR / ADR / incident / ticket. Records without a source are lower-trust. |
| `confidence` | `low` \| `medium` \| `high`. Default `medium`. *Agent-suggested records cannot claim `high`. Records without a `source` cannot be `high` — invariant enforced at write time.* |
| `reviewAfter` | ISO date; if past, search flags `stale: true`. |
| `supersededBy` | ID of the record that replaces this one. |
| `restricted` | Excluded from search unless `includeRestricted: true`. Via MCP, both `search_lore` and `get_lore` are env-gated by `LORE_ALLOW_RESTRICTED_MCP`; with the gate off, `get_lore` of a restricted id returns a minimal refusal (no title/body). |
| `lastVerifiedAt` | Bumped by `lore verify <id>`. |

`restricted` is a **retrieval guard**, not a data-loss-prevention mechanism.
Use it to hide a record from a casual search, not to keep secrets out of an
LLM prompt — once retrieved, the content is in the agent's context.

## Where data lives

A single SQLite file at `~/.lore/lore.db` (mode `0600`). That's the entire
storage layer.

**For v0.1, SQLite is the source of truth.** Team sync is intentionally
manual: back up or copy the DB yourself if you need it on another machine.
Markdown import (PR-reviewable `.lore/*.md` files as canonical, SQLite as
local index) is planned for v0.2 but not required for local use.

Override the path with `LORE_DB=/some/other.db` for tests or alternate
profiles.

### Inspect / back up your lore

`lore export` writes the DB as a single JSON document so you can read,
diff, commit, or copy it without touching SQLite directly:

```bash
lore export                              # stdout, active + non-restricted
lore export --out lore-backup.json       # file (mode 0600)
lore export --include-drafts --include-deprecated --include-superseded --include-restricted --out full.json
```

Envelope: `{ schemaVersion: 1, exportedAt, records: [Lore, ...] }`. Stable
ordering by `updatedAt desc` with an `id asc` tiebreak — two exports of
the same DB diff cleanly. Import is not implemented yet; for v0.1 the
SQLite file remains the source of truth.

## Security

See [`docs/SECURITY.md`](docs/SECURITY.md) and [`docs/DATA-FLOW.md`](docs/DATA-FLOW.md).

**`lore` protects against:**

- Accidental over-sharing (drafts hidden by default; `restricted` excluded by default; both MCP `search_lore` and `get_lore` env-gated for restricted records).
- Stale or unreviewed memory dominating retrieval (`stale: true` flag; lifecycle filtering; agent suggestions land as drafts).
- Audit-log leakage of body content (sanitised pre-write; `lore audit` renders redacted by default).

**`lore` does not protect against:**

- A malicious local user with filesystem access. The DB is mode 0600 but anyone who can read it can read every record.
- Secrets intentionally added to lore. Use a secrets manager; `restricted` is a retrieval guard, not a vault.
- An LLM provider seeing content the agent has retrieved. That's the standard trust boundary you already accept for any AI tool use.
- Compromise of the MCP client or shell environment.

Short version:

- The server uses stdio transport only. No network listener, ever.
- The `lore` application code uses stdio transport only and makes no outbound HTTP calls. The MCP SDK dependency includes unused HTTP/client modules; `lore` does not import or configure them. No telemetry or analytics SDKs.
- The DB file is local, mode 0600, in your home directory.
- Audit log at `~/.lore/audit.jsonl`: every **MCP tool call** timestamped (with request args and result IDs, never result bodies). CLI mutations are recorded separately in the SQLite `events` table (`created`, `suggested`, `approved`, `deprecated`, `superseded`, `verified`, `updated`, `deleted`) keyed by lore id.

Data does leave your machine the moment Claude reads a tool result — it goes
to your LLM provider as part of the next prompt. That's the standard trust
boundary you already accept for any AI tool use. For enterprise, use your
provider's Zero Data Retention plan.

## License

MIT.
