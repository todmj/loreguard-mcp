/**
 * Shared types between the DB layer, core operations, the CLI, and the MCP
 * server. Kept narrow on purpose — surface area changes are migrations.
 *
 * Vocabulary:
 *   - "lore"   = a single record (a convention, decision, gotcha, lesson)
 *   - "draft"  = agent-suggested, not yet human-approved
 *   - "active" = canonical; visible to search by default
 *   - "deprecated" / "superseded" = retired; hidden by default
 *   - "restricted" = retrieval guard (excluded unless explicitly opted in).
 *                    NOT a DLP/access-control mechanism; document accordingly.
 */

export type LoreStatus = "draft" | "active" | "deprecated" | "superseded";
export type LoreConfidence = "low" | "medium" | "high";

export interface LoreRow {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly author: string | null;
  readonly team: string | null;
  readonly status: LoreStatus;
  readonly source: string | null;
  readonly review_after: string | null;
  readonly confidence: LoreConfidence;
  readonly superseded_by: string | null;
  readonly restricted: 0 | 1;
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_verified_at: string | null;
}

/**
 * Full Lore — returned by getLore() and the MCP `get_lore` tool. This is
 * the only shape that includes the full `body`. Search deliberately uses
 * LoreSummary to keep agent context cheap.
 */
export interface Lore {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly author?: string;
  readonly team?: string;
  readonly status: LoreStatus;
  readonly source?: string;
  readonly reviewAfter?: string;
  readonly confidence: LoreConfidence;
  readonly supersededBy?: string;
  readonly restricted: boolean;
  readonly repos: ReadonlyArray<string>;
  readonly tags: ReadonlyArray<string>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastVerifiedAt?: string;
}

/**
 * Brief-by-default projection used by search. Full body deliberately
 * omitted so an LLM context isn't ballooned by an archive on every hit.
 * Use `get_lore(id)` to fetch the body on demand.
 *
 * Includes the trust-relevant metadata (status / source / confidence /
 * stale) so the agent doesn't need a second tool call to know whether
 * to trust a result.
 */
export interface LoreSummary {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly author?: string;
  readonly team?: string;
  readonly status: LoreStatus;
  readonly source?: string;
  readonly confidence: LoreConfidence;
  readonly restricted: boolean;
  readonly repos: ReadonlyArray<string>;
  readonly tags: ReadonlyArray<string>;
  readonly updatedAt: string;
  readonly lastVerifiedAt?: string;
  /** Set true when review_after is in the past. UI surfaces a warning. */
  readonly stale: boolean;
  /** FTS rank, lower = more relevant. Undefined when no query was given. */
  readonly score?: number;
  /**
   * IDs of other `active` records in the SAME search response that share
   * at least one repo AND at least one tag with this one — i.e. plausible
   * conflicting authorities. Populated by `searchLore` after the result
   * set is assembled; intentionally scoped to the current response so the
   * agent / reviewer sees the contradiction without an extra round trip.
   * Empty / omitted when nothing in the response qualifies.
   */
  readonly conflicts?: ReadonlyArray<string>;
}

export interface SearchOptions {
  readonly query?: string;
  readonly repo?: string;
  readonly tag?: string;
  /** ISO timestamp; only lore updated on/after this is returned. */
  readonly updatedAfter?: string;
  /** Default false. */
  readonly includeRestricted?: boolean;
  /** Default false; agents shouldn't see unreviewed material by default. */
  readonly includeDrafts?: boolean;
  /** Default false. */
  readonly includeDeprecated?: boolean;
  /** Default false. */
  readonly includeSuperseded?: boolean;
  readonly limit?: number;
}

/**
 * Both `addLore` (status=active) and `suggestLore` (status=draft) share
 * the same input shape. The caller decides the default by which entry
 * point they call.
 */
export interface AddLoreInput {
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly author?: string;
  readonly team?: string;
  readonly source?: string;
  readonly reviewAfter?: string;
  readonly confidence?: LoreConfidence;
  readonly repos?: ReadonlyArray<string>;
  readonly tags?: ReadonlyArray<string>;
  readonly restricted?: boolean;
}

/**
 * Partial-update shape for `updateLore`. Any field set is applied; tags
 * and repos when set REPLACE the existing list (caller passes the full
 * desired set). Status is intentionally NOT updatable here — use
 * approveLore / deprecateLore / supersedeLore for lifecycle transitions.
 */
export interface UpdateLoreInput {
  readonly title?: string;
  readonly summary?: string;
  readonly body?: string;
  readonly author?: string;
  readonly team?: string;
  readonly source?: string;
  readonly reviewAfter?: string | null;
  readonly confidence?: LoreConfidence;
  readonly repos?: ReadonlyArray<string>;
  readonly tags?: ReadonlyArray<string>;
  readonly restricted?: boolean;
}
