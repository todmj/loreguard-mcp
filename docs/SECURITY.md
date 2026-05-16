# Security

## Threat model

`lore` is local-first by design. The threat model is:

1. **A compromised agent or sloppy prompt should not leak restricted records.**
   Mitigation: `restricted: true` records are excluded from default
   search; opting in requires an explicit flag, which is audit-logged.
2. **An agent's "suggest_lore" output should not poison the trusted set.**
   Mitigation: agent suggestions land as `status: draft`; default search
   ignores drafts; a human must run `lore approve <id>` to promote.
3. **Stale knowledge should not silently masquerade as authoritative.**
   Mitigation: records carry `reviewAfter`; search results carry
   `stale: true` when the date has passed; the CLI prints a warning.
4. **The server itself should not exfiltrate data.**
   Mitigation: no outbound HTTP code, no telemetry, stdio-only
   transport. Dependency list is short — audit `package.json`.

What's NOT in scope:

- DLP / access control. `restricted` is a retrieval guard, not a
  cryptographic barrier. Anyone with read access to the DB file can
  read every record. Don't store secrets in `lore`.
- Multi-user authentication. The DB file is a single-user local store.
  Team sync is out of scope for v0.1 (see ROADMAP / future).

## Defaults

| Setting | Default |
|---------|---------|
| Transport | stdio only (no HTTP server) |
| DB location | `~/.lore/lore.db` |
| DB file mode | `0600` (owner read/write) |
| DB parent dir mode | `0700` |
| Audit log | `~/.lore/audit.jsonl`, mode `0600`, append-only |
| Network egress | None. No `fetch`, `axios`, or analytics SDKs in the dep tree. |
| Search excludes by default | `draft`, `deprecated`, `superseded`, `restricted` |

## Audit log

Every tool call lands in `~/.lore/audit.jsonl`:

```json
{
  "ts": "2026-05-16T11:32:18.412Z",
  "tool": "search_lore",
  "request": { "query": "password hashing", "repo": "payments-svc" },
  "resultCount": 2,
  "resultIds": ["7vk3qm9b", "h44z8n3q"]
}
```

Inspect with `lore audit --n 50`.

We never log the full result body — that's the data we're trying to
protect. Only enough to answer "what did Claude see at 14:32?".

Disable for tests with `LORE_AUDIT_OFF=1`. Not recommended in production.

## Hardening for enterprise

- **Anthropic Zero Data Retention plan**: tokens used to generate the
  response are not retained on the provider side. Required if your data
  classification forbids any provider retention.
- **Self-hosted model**: data never leaves your network. The MCP server
  doesn't care which LLM client calls it.
- **OS-level egress block** on the `lore-mcp` binary (Little Snitch /
  nftables) — belt and braces. The server has no outbound code but a
  firewall rule proves it.
- **Pin dependencies**: `pnpm install --frozen-lockfile` in CI. We ship
  with a committed `pnpm-lock.yaml`.
- **Code audit**: dep tree is intentionally short. The full hot path is
  `better-sqlite3` (SQLite bindings), `@modelcontextprotocol/sdk` (MCP
  framework), and `zod` (input validation). No telemetry, no analytics,
  no auto-update.

## What about secrets in lore?

Don't put them there. `lore` is for *conventions and decisions*, not
credentials or tokens. If someone records "the prod API key is X" they
have made a mistake the tool can't fix.

The `restricted: true` flag exists to keep sensitive *knowledge* (e.g.
"the on-call rotation for SecOps is in PagerDuty group N") out of casual
searches, not to keep secrets out of the database. Secrets belong in a
secrets manager.
