import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { audit } from "../core/audit.js";
import {
  findPossibleDuplicates,
  getLore,
  reportConflict,
  ReportConflictError,
  searchLore,
  suggestLore,
} from "../core/lore.js";
import { openDb } from "../db/index.js";
import {
  redactRestricted,
  shouldGateRestrictedGet,
  stripPossibleConflicts,
} from "./redact.js";

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
 *                    a human runs `loreguard approve <id>`. Agents cannot
 *                    promote their own records.
 *
 * Every tool call is recorded to `~/.loreguard/audit.jsonl` with the request
 * args, result count, and result ids — never the full result bodies.
 */
export async function runMcpServer(): Promise<void> {
  const db = openDb();

  const server = new McpServer({
    name: "loreguard",
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
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe(
            "Narrow to records carrying this tag, or any of these tags " +
              "if a list is given (ANY-of). Tags are lowercased / hyphenated " +
              "automatically — pass them however you like.",
          ),
        prefix: z
          .boolean()
          .optional()
          .describe(
            "If true, query tokens of 3+ chars match as PREFIXES " +
              "('timez' → 'timezone'). Off by default; turn on when you're " +
              "guessing at a term or want broader recall.",
          ),
        updatedAfter: z
          .string()
          .optional()
          .describe(
            "ISO timestamp. Returns only records whose `updated_at` is " +
              "on/after this. Use sparingly — most useful queries don't " +
              "filter by time. Format: '2026-01-15' or full ISO datetime.",
          ),
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
        includeSuperseded: z
          .boolean()
          .optional()
          .describe(
            "If true, also return records that have been superseded by a " +
              "newer record. Default false — the superseding record is " +
              "usually what you want.",
          ),
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
        const hits = searchLore(db, {
          query: args.query,
          repo: args.repo,
          tag: args.tag,
          prefix: args.prefix,
          updatedAfter: args.updatedAfter,
          includeDrafts: args.includeDrafts,
          includeDeprecated: args.includeDeprecated,
          includeSuperseded: args.includeSuperseded,
          // R4 — env-gated. The agent can ASK for restricted records, but
          // the server ignores the flag unless LOREGUARD_ALLOW_RESTRICTED_MCP=1
          // is set at startup. Belt-and-braces beyond the schema default.
          includeRestricted:
            process.env["LOREGUARD_ALLOW_RESTRICTED_MCP"] === "1"
              ? args.includeRestricted
              : false,
          limit: args.limit,
        });
        audit({
          tool: "search_lore",
          request: args as Record<string, unknown>,
          resultCount: hits.length,
          resultIds: hits.map((h) => h.id),
        });
        // possibleConflicts is a CLI-only heuristic for human triage —
        // see stripPossibleConflicts for the rationale.
        const mcpHits = stripPossibleConflicts(hits);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ results: mcpHits }, null, 2),
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
        // R4 — restricted gate. `search_lore` already env-gates restricted
        // retrieval; without a matching gate here, an agent with an id from
        // a stale audit / CLI output / prior context can bypass the search
        // filter and fetch the body. Same env knob as search, minimal
        // refusal shape (no title) so the response itself can't leak.
        if (shouldGateRestrictedGet(lore, process.env)) {
          audit({
            tool: "get_lore",
            request: args as Record<string, unknown>,
            resultCount: 1,
            resultIds: [lore!.id],
            blocked: "restricted",
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(redactRestricted(lore!.id), null, 2),
              },
            ],
          };
        }
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
        "invisible to default search until a human runs `loreguard approve " +
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
          .max(800)
          .describe(
            "One-paragraph summary (≤ 800 chars). This is what most search " +
              "results show — should stand alone without the body; assume " +
              "readers won't drill in. Aim for the *why* and the *what*, " +
              "not just the *what*; a longer cap exists so search hits can " +
              "be self-contained without a follow-up get_lore call.",
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
      // Build a sanitised audit shape that DELIBERATELY omits the body
      // (and summary length is bounded by the schema so it's safe to keep).
      // This is the trust-model boundary called out in SECURITY.md — the
      // audit log records that a suggestion happened, not the suggestion's
      // contents. To inspect the content, read the SQLite `lore` row.
      const sanitised: Record<string, unknown> = {
        title: args.title,
        summaryChars: args.summary.length,
        bodyChars: args.body.length,
        repos: args.repos,
        tags: args.tags,
        source: args.source,
        confidence: args.confidence,
        team: args.team,
      };
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
        // Hint-only duplicate check. Never blocks — the human reviewer
        // decides. Surfaced in the response so the calling agent can warn
        // the user inline ("I drafted this but here are 2 similar
        // existing records"), and counted in the audit so a human reading
        // ~/.loreguard/audit.jsonl can see how often agents suggest near-dupes.
        //
        // Restricted handling: titles of restricted records are not
        // surfaced unless LOREGUARD_ALLOW_RESTRICTED_MCP=1 (same env knob that
        // governs search and get). Restricted matches are still counted
        // so the response can say "and N more we're not showing you".
        const allowRestricted =
          process.env["LOREGUARD_ALLOW_RESTRICTED_MCP"] === "1";
        const { duplicates: possibleDuplicates, restrictedDuplicateCount } =
          findPossibleDuplicates(
            db,
            {
              id: lore.id,
              title: args.title,
              repos: args.repos,
              tags: args.tags,
            },
            { allowRestricted },
          );
        sanitised["possibleDuplicateCount"] = possibleDuplicates.length;
        sanitised["restrictedDuplicateCount"] = restrictedDuplicateCount;
        audit({
          tool: "suggest_lore",
          request: sanitised,
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
                    "Draft created. A human will review with `loreguard review` and " +
                    "promote with `loreguard approve " + lore.id + "`.",
                  possibleDuplicates,
                  restrictedDuplicateCount,
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
          request: sanitised,
          error: msg,
        });
        return {
          isError: true,
          content: [{ type: "text", text: `suggest_lore failed: ${msg}` }],
        };
      }
    },
  );

  // ---- report_conflict -------------------------------------------------
  server.registerTool(
    "report_conflict",
    {
      title: "Report a conflict against a canonical lore record",
      description:
        "Use when you've found code (or another authoritative source) " +
        "that contradicts an existing ACTIVE lore record. Creates a DRAFT " +
        "counter-record linked back to the original via `conflictsWith` — " +
        "it lands in `loreguard review` for the human to triage. The " +
        "original record is NEVER mutated; the link is one-way. Resolution " +
        "is the reviewer's call (approve the counter-claim → use " +
        "`loreguard supersede` or `loreguard update` to fix the original; " +
        "reject → the original stands).\n\n" +
        "Distinct from the runtime `possibleConflicts` heuristic on search " +
        "results — that's shared-scope overlap detection. This is explicit, " +
        "persisted, agent-flagged disagreement.",
      inputSchema: {
        existingId: z
          .string()
          .min(1)
          .describe(
            "The 8-char id of the existing ACTIVE record being challenged. " +
              "Get this from a prior `search_lore` or `get_lore` call.",
          ),
        observation: z
          .string()
          .min(1)
          .max(800)
          .describe(
            "What did you observe that contradicts the existing record? " +
              "Stand-alone explanation — the reviewer reads this without " +
              "additional context. ≤ 800 chars (mirrors suggest_lore.summary).",
          ),
        source: z
          .string()
          .url()
          .optional()
          .describe(
            "URL pointing at the contradicting evidence (commit, PR, " +
              "code permalink). Counter-claims with a source are higher-trust.",
          ),
        repos: z
          .array(z.string())
          .optional()
          .describe(
            "Repos this counter-claim is scoped to. Inherits from the " +
              "challenged record if omitted (handled by the reviewer).",
          ),
        tags: z
          .array(z.string())
          .optional()
          .describe(
            "Extra tags. 'conflict-report' is always added automatically.",
          ),
      },
    },
    async (args) => {
      // Audit shape mirrors suggest_lore: never record the observation
      // body, just its length, so the audit log can be grepped for
      // "agent X repeatedly challenges record Y" without leaking content.
      const sanitised: Record<string, unknown> = {
        existingId: args.existingId,
        observationChars: args.observation.length,
        source: args.source,
        repos: args.repos,
        tags: args.tags,
      };
      try {
        // Defence in depth — the core reportConflict also refuses
        // restricted, but the MCP gate is the env-gated boundary the
        // user explicitly configured. Returning the redacted-restricted
        // shape (matching get_lore) keeps the audit + response surface
        // consistent for restricted hits. Note: a restricted refusal
        // is still distinguishable from an unknown id (different
        // response payload), same as today's get_lore — closing that
        // oracle would require pre-checking and returning the same
        // redaction shape for both, which is a separate decision.
        const existing = getLore(db, args.existingId);
        if (existing && existing.restricted &&
            process.env["LOREGUARD_ALLOW_RESTRICTED_MCP"] !== "1") {
          audit({
            tool: "report_conflict",
            request: sanitised,
            blocked: "restricted",
          });
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    error: "restricted",
                    hint: "Set LOREGUARD_ALLOW_RESTRICTED_MCP=1 to allow MCP access to restricted lore.",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        const draft = reportConflict(db, {
          existingId: args.existingId,
          observation: args.observation,
          source: args.source,
          repos: args.repos,
          tags: args.tags,
        });
        audit({
          tool: "report_conflict",
          request: sanitised,
          resultCount: 1,
          resultIds: [draft.id],
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  id: draft.id,
                  status: draft.status,
                  conflictsWith: draft.conflictsWith ?? [],
                  message:
                    "Counter-draft created. A human will review with `loreguard review` and " +
                    "either approve / reject / edit / supersede the original.",
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        const reason =
          err instanceof ReportConflictError ? err.reason : "internal_error";
        const msg = err instanceof Error ? err.message : String(err);
        audit({
          tool: "report_conflict",
          request: sanitised,
          error: `${reason}: ${msg}`,
        });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `report_conflict failed (${reason}): ${msg}`,
            },
          ],
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
