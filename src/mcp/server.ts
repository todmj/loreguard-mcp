import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { audit } from "../core/audit.js";
import {
  getLore,
  searchLore,
  suggestLore,
} from "../core/lore.js";
import { openDb } from "../db/index.js";

/**
 * R1 — MCP server. Stdio transport only (no network listener). Three
 * tools exposed to the client:
 *
 *   - search_lore  — brief-by-default; default-filtered to active records,
 *                    excludes drafts/deprecated/superseded/restricted unless
 *                    explicitly opted in via flags. The token-saving entry.
 *   - get_lore     — full body of one record by id. Use this AFTER a
 *                    search hit to spend tokens on detail only when needed.
 *   - suggest_lore — agent-authored knowledge lands as a DRAFT
 *                    (status='draft'). Hidden from default search until
 *                    a human runs `lore approve <id>`. Agents cannot
 *                    promote their own records.
 *
 * Every tool call is recorded to `~/.lore/audit.jsonl` with the request
 * args, result count, and result ids — never the full result bodies.
 */
export async function runMcpServer(): Promise<void> {
  const db = openDb();

  const server = new McpServer({
    name: "lore",
    version: "0.1.0",
  });

  // ---- search_lore -----------------------------------------------------
  server.registerTool(
    "search_lore",
    {
      title: "Search team lore",
      description:
        "Search the local lore database for relevant team conventions, " +
        "decisions, and gotchas. Returns BRIEF summaries (no body). Call " +
        "get_lore({ id }) afterwards if you need the full body. Designed " +
        "for token efficiency — prefer this over re-reading source.\n\n" +
        "Default behaviour: returns only 'active' records, excludes drafts " +
        "and deprecated/superseded items. Results include `stale: true` " +
        "when the record's review date has passed; treat stale results as " +
        "starting points rather than authority.\n\n" +
        "Examples of good queries: \"password hashing\", \"date timezone " +
        "payments-svc\", \"migration style guide\".",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            "Free-text query (matches title, summary, and body via FTS5). " +
              "Omit to list recent active records.",
          ),
        repo: z
          .string()
          .optional()
          .describe(
            "Narrow to records tagged for this repo (use the repo's name as " +
              "you'd write it in a Git URL, e.g. 'payments-svc').",
          ),
        tag: z
          .string()
          .optional()
          .describe("Narrow to records carrying this tag (lowercased, hyphenated)."),
        since: z
          .string()
          .optional()
          .describe("ISO timestamp; only records updated on/after this are returned."),
        includeDrafts: z
          .boolean()
          .optional()
          .describe(
            "If true, also return agent-suggested drafts awaiting human approval. " +
              "Default false — drafts haven't been reviewed and may be wrong.",
          ),
        includeDeprecated: z
          .boolean()
          .optional()
          .describe("If true, also return records the team has marked deprecated."),
        includeRestricted: z
          .boolean()
          .optional()
          .describe(
            "If true, also return records the team has marked restricted. " +
              "Default false — most agent tasks should leave this off.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max results. Default 10, hard cap 50."),
      },
    },
    async (args) => {
      try {
        const hits = searchLore(db, args);
        audit({
          tool: "search_lore",
          request: args as Record<string, unknown>,
          resultCount: hits.length,
          resultIds: hits.map((h) => h.id),
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ results: hits }, null, 2),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        audit({
          tool: "search_lore",
          request: args as Record<string, unknown>,
          error: msg,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `search_lore failed: ${msg}` }],
        };
      }
    },
  );

  // ---- get_lore --------------------------------------------------------
  server.registerTool(
    "get_lore",
    {
      title: "Fetch one lore record (full body)",
      description:
        "Return the full record for a lore id (including the body, which " +
        "search_lore omits). Use this AFTER a search to spend tokens on a " +
        "specific note's detail. Returns null when no record matches.",
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe(
            "The 8-char lore id, e.g. '7vk3qm9b'. Get this from search_lore.",
          ),
      },
    },
    async (args) => {
      try {
        const lore = getLore(db, args.id);
        audit({
          tool: "get_lore",
          request: args as Record<string, unknown>,
          resultCount: lore ? 1 : 0,
          resultIds: lore ? [lore.id] : [],
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(lore, null, 2),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        audit({
          tool: "get_lore",
          request: args as Record<string, unknown>,
          error: msg,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `get_lore failed: ${msg}` }],
        };
      }
    },
  );

  // ---- suggest_lore ----------------------------------------------------
  server.registerTool(
    "suggest_lore",
    {
      title: "Suggest a new lore record (draft)",
      description:
        "Record something you've learned during this session so future " +
        "sessions can retrieve it. The record is created as a DRAFT — " +
        "invisible to default search until a human runs `lore approve " +
        "<id>`. This is the poisoning-prevention guard: agents can " +
        "suggest knowledge, but humans decide what becomes canonical.\n\n" +
        "Use this for genuinely durable observations: team conventions " +
        "you've inferred, gotchas you've hit, cross-repo rules you've " +
        "discovered. NOT for transient debug notes or task-specific " +
        "context — that belongs in the chat, not the long-term memory.",
      inputSchema: {
        title: z.string().min(1).max(200).describe("Short title — what is the rule / fact?"),
        summary: z
          .string()
          .min(1)
          .max(500)
          .describe(
            "One-paragraph summary. This is what most search results show. " +
              "Should stand alone without the body — assume readers won't drill in.",
          ),
        body: z
          .string()
          .min(1)
          .describe(
            "Full detail / reasoning / evidence. Markdown is fine. " +
              "Include enough context to verify the claim.",
          ),
        repos: z
          .array(z.string())
          .optional()
          .describe(
            "Repos this rule applies to. Helps future agents narrow searches.",
          ),
        tags: z
          .array(z.string())
          .optional()
          .describe(
            "Lowercase tags. Common tags include: security, dates, db, auth, " +
              "deploy, conventions, gotchas, incident-lessons.",
          ),
        source: z
          .string()
          .url()
          .optional()
          .describe(
            "URL: PR / ADR / incident / Slack permalink that justifies this " +
              "record. Records WITHOUT a source are treated as lower-trust.",
          ),
        confidence: z
          .enum(["low", "medium", "high"])
          .optional()
          .describe(
            "How sure are you? Default 'medium'. Use 'low' for inferred " +
              "conventions; 'high' only when you have a source link.",
          ),
        team: z.string().optional().describe("Owning team, if known."),
      },
    },
    async (args) => {
      try {
        const lore = suggestLore(db, {
          title: args.title,
          summary: args.summary,
          body: args.body,
          repos: args.repos,
          tags: args.tags,
          source: args.source,
          confidence: args.confidence,
          team: args.team,
          author: "agent",
        });
        audit({
          tool: "suggest_lore",
          request: { ...(args as Record<string, unknown>), bodyChars: args.body.length },
          resultCount: 1,
          resultIds: [lore.id],
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  id: lore.id,
                  status: lore.status,
                  message:
                    "Draft created. A human will review with `lore review` and " +
                    "promote with `lore approve " + lore.id + "`.",
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        audit({
          tool: "suggest_lore",
          request: args as Record<string, unknown>,
          error: msg,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `suggest_lore failed: ${msg}` }],
        };
      }
    },
  );

  // Connect on stdio. The MCP client (Claude Code, Cursor, etc.) is the
  // parent process; we read JSON-RPC framed messages on stdin, reply on
  // stdout. Logs go to stderr.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Block forever — connect() returns once the transport is bound; the
  // server runs as long as stdin stays open. Closing stdin (client
  // disconnect) exits the process.
}
