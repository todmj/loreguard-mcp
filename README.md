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
```

This is the poisoning-prevention guard: agents can suggest knowledge, but
they can't make future agents trust it.

## Search

```bash
lore search bcrypt
lore search "password hashing" --repo payments-svc
lore show <id>
```

CLI search returns the compact `LoreSummary` (no body) by default. `lore show`
fetches the full body. Same contract as the MCP tools.

## Hook it up to Claude Code

```bash
claude mcp add lore lore-mcp
```

Claude sees three tools:

- `search_lore({ query, repo?, tag?, since?, includeDrafts?, includeDeprecated?, includeRestricted? })` — returns brief summaries
- `get_lore({ id })` — full body of one record
- `suggest_lore({ title, summary, body, repos?, tags?, source?, confidence? })` — agent creates a draft

Prompt suggestion (drop in your `CLAUDE.md`):

```md
Before non-trivial code changes, search `lore` for the repo name and the
subsystem you're touching (auth, dates, migrations, deploy, payments).
Trust active records with matching repo scope first; treat stale
(`stale: true`) and `confidence: low` results as starting points, not authority.
```

## Trust model

Every record carries lifecycle + provenance metadata so retrieval is honest:

| Field | Meaning |
|-------|---------|
| `status` | `draft` (agent, awaiting review), `active` (canonical), `deprecated`, `superseded` |
| `source` | URL: PR / ADR / incident / ticket. Records without a source are lower-trust. |
| `confidence` | `low` \| `medium` \| `high`. Default `medium`. |
| `reviewAfter` | ISO date; if past, search flags `stale: true`. |
| `supersededBy` | ID of the record that replaces this one. |
| `restricted` | Excluded from search unless `includeRestricted: true`. |
| `lastVerifiedAt` | Bumped by `lore verify <id>`. |

`restricted` is a **retrieval guard**, not a data-loss-prevention mechanism.
Use it to hide a record from a casual search, not to keep secrets out of an
LLM prompt — once retrieved, the content is in the agent's context.

## Where data lives

A single SQLite file at `~/.lore/lore.db` (mode `0600`). That's the entire
storage layer. Back it up, sync it via S3, copy it between machines — whatever
you want.

## Security

See [`docs/SECURITY.md`](docs/SECURITY.md) and [`docs/DATA-FLOW.md`](docs/DATA-FLOW.md).

Short version:

- The server uses stdio transport only. No network listener, ever.
- The server has zero outbound HTTP. Audit `package.json` to verify.
- The DB file is local, mode 0600, in your home directory.
- Audit log at `~/.lore/audit.jsonl`: every tool call timestamped.

Data does leave your machine the moment Claude reads a tool result — it goes
to your LLM provider as part of the next prompt. That's the standard trust
boundary you already accept for any AI tool use. For enterprise, use your
provider's Zero Data Retention plan.

## License

MIT.
