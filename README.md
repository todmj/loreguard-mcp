# lore

> Just-in-time local memory for AI coding agents.
> A local SQLite-backed MCP server + CLI for durable, searchable context.

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
npm link                      # makes `lore` and `lore-mcp` available on $PATH
lore init
```

`npm link` symlinks the local `dist/bin/lore.js` and `dist/bin/lore-mcp.js`
into your global npm prefix, so `lore` and `lore-mcp` work from any
directory just like an npm-installed package would. To uninstall later:

```bash
cd lore-mcp && npm unlink -g
```

Don't want `npm link`? Skip it and reference the absolute path everywhere
(e.g. in `claude mcp add` — see [Hook it up to Claude Code](#hook-it-up-to-claude-code)
below).

Once the package is published on npm this will simplify to:

```bash
npm i -g lore-mcp
lore init
```

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

## Let agents write things down

During a session, Claude can call `suggest_lore` when it discovers something
useful — a convention, a gotcha, a service-specific rule. Suggestions land as
**drafts**: invisible to default search until a human approves them.

```bash
lore review            # list pending drafts
lore approve <id>      # promote draft → active
lore deprecate <id>    # mark deprecated (still findable with a flag)
lore supersede <old> --with <new>
lore verify <id>       # bump lastVerifiedAt and clear stale warning
```

This is the poisoning-prevention guard: **agents can suggest knowledge, but
only humans (via the CLI) can approve, deprecate, or supersede records.**
The MCP server deliberately exposes no `approve` tool — agents cannot
promote their own suggestions.

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

That's typically 100–200 tokens. The full body lives in `get_lore({ id })`
and is only fetched when the summary isn't enough — that's where the
token saving comes from.

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

- `search_lore({ query, repo?, tag?, updatedAfter?, includeDrafts?, includeDeprecated?, includeRestricted?, limit? })` — returns brief summaries
- `get_lore({ id })` — full body of one record
- `suggest_lore({ title, summary, body, repos?, tags?, source?, confidence?, team? })` — agent creates a draft

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
body only on demand via `get_lore`. That's the token-saving contract.

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
| `restricted` | Excluded from search unless `includeRestricted: true`. |
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

## Security

See [`docs/SECURITY.md`](docs/SECURITY.md) and [`docs/DATA-FLOW.md`](docs/DATA-FLOW.md).

**`lore` protects against:**

- Accidental over-sharing (drafts hidden by default; `restricted` excluded by default; MCP `includeRestricted` env-gated).
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
