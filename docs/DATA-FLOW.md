# Data flow

```
┌──────────────────┐         ┌──────────────────┐         ┌────────────────────────┐
│  ~/.loreguard/lore.db │  ◀────▶ │ loreguard-mcp    │  stdio  │  Claude Code / Cursor  │
│  (SQLite, 0600)  │         │   (subprocess)   │  ─────▶ │  / your MCP client     │
└──────────────────┘         └──────────────────┘         └────────────┬───────────┘
                                                                       │
                                                                       │ HTTPS
                                                                       ▼
                                                          ┌─────────────────────────┐
                                                          │  LLM provider           │
                                                          │  (Anthropic / OpenAI /  │
                                                          │   self-hosted)          │
                                                          └─────────────────────────┘
```

What crosses each boundary:

| From | To | What | Notes |
|------|----|------|-------|
| SQLite file | `loreguard-mcp` process | Query results (rows) | In-process; never leaves the local subprocess as bytes on the wire. |
| `loreguard-mcp` | MCP client | JSON tool-call results over stdio | Subprocess pipes only — no network. Audit log records every call. |
| MCP client | LLM provider | Tool results inlined into the next prompt | This is the data-egress point. Standard trust boundary you already accept for any AI tool use. |

## What never crosses any boundary

- The full audit log (`~/.loreguard/audit.jsonl`) stays local. The MCP server
  never emits audit lines as tool results.
- The DB file is never read by the MCP server other than through SQL
  queries — there's no "dump the whole table" tool.
- The `loreguard` application code makes no outbound HTTP calls. `package.json`
  deliberately has no `axios` / `node-fetch` / telemetry SDKs. The
  `@modelcontextprotocol/sdk` dependency does include unused HTTP/client
  modules; `loreguard` does not import or configure them. For defence in depth,
  an OS-level egress block on the binary (Little Snitch / nftables) closes
  the gap regardless of dep-tree contents.

## What does leave your machine

Once Claude reads a search result, that result is in the model's context.
On the model provider's side:

- **Anthropic (default)**: standard inference path. Tokens retained per
  their published policy.
- **Anthropic enterprise with ZDR**: tokens not retained.
- **Self-hosted model**: never leaves your network.

If you have records marked `restricted: true`, **set `includeRestricted`
to false by default** in any agent's system prompt. The MCP tool already
defaults to false, but a sloppy prompt could ask the agent to pass `true`.
The audit log will show every time it does.

## Storage location

- DB: `~/.loreguard/lore.db` (mode `0600`, parent dir `0700`)
- Audit: `~/.loreguard/audit.jsonl` (mode `0600`)
- Override either via `LOREGUARD_DB` / `LOREGUARD_AUDIT_LOG` env vars (useful for
  team-shared DBs on a synced volume or for test fixtures).
