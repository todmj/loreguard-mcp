# lore

> Cross-repo team knowledge for AI agents.
> MCP server + CLI backed by a local SQLite file.

When you spin up Claude Code in repo A, it has no idea your team standardised on
bcrypt → Argon2 last quarter, or that `payments-svc` never accepts dates without
a timezone. `lore` is where that knowledge lives, in a single SQLite file, queryable
by both humans (via CLI) and AI agents (via MCP).

## Install

```bash
npm i -g lore-mcp
lore init
```

## Add an idea

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
Argon2id with m=64MB, t=3, p=4 is the new baseline. RFC link in #platform-sec." \
  --repo payments-svc --repo auth-svc \
  --tag security --tag passwords \
  --team Platform
```

## Search from the CLI

```bash
lore search bcrypt
lore search "password hashing" --repo payments-svc
lore show <id>
```

## Hook it up to Claude Code

```bash
claude mcp add lore lore-mcp
```

That's it. Claude will see three tools:

- `search_ideas({ query, repo?, tag?, since?, includeConfidential? })`
- `get_idea({ id })`
- `add_idea({ title, summary, body, repos?, tags?, author?, team?, confidential? })`

Use it in a session: *"check lore for our convention on database migrations"* — and Claude will search before guessing.

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
- Ideas marked `confidential: true` are excluded from search by default and
  require an explicit `includeConfidential: true` flag.

Data does leave your machine the moment Claude reads a tool result — it goes
to your LLM provider as part of the next prompt. That's the standard trust
boundary you already accept for any AI tool use. For enterprise, use your
provider's Zero Data Retention plan.

## License

MIT.
