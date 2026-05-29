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
  /**
   * JSON-encoded array of lore ids that this record explicitly
   * challenges (counter-claim). NULL on every record that isn't a
   * counter-record — never the empty array `"[]"`. See ADR-003.
   */
  readonly conflicts_with: string | null;
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
  /**
   * Explicit team-ratified disagreement: ids of canonical records this
   * record challenges. Populated only on counter-records created via
   * `reportConflict`; `undefined` on every other record (NOT `[]` — the
   * absence is the meaningful state). Distinct from the runtime
   * `possibleConflicts` heuristic on LoreSummary, which is shared-scope
   * overlap detection. See ADR-003.
   */
  readonly conflictsWith?: ReadonlyArray<string>;
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
   * at least one repo AND at least one tag with this one — i.e. records
   * that POSSIBLY conflict. This is an overlap heuristic, not contradiction
   * detection: two records sharing scope might be complementary or might
   * disagree, and a human / agent has to read both to know. Populated by
   * `searchLore` after the result set is assembled; intentionally scoped
   * to the current response. Empty / omitted when nothing qualifies.
   */
  readonly possibleConflicts?: ReadonlyArray<string>;
  /**
   * Same `conflictsWith` semantics as on `Lore` — explicit counter-claim
   * link from `reportConflict`. Surfaced in search so the agent (and
   * the CLI renderer) can flag counter-records without a separate
   * round trip. `undefined` on non-counter records.
   */
  readonly conflictsWith?: ReadonlyArray<string>;
}

export interface SearchOptions {
  readonly query?: string;
  readonly repo?: string;
  /**
   * Single tag or a list of tags. ANY-of semantics: a record matches if
   * it carries at least one of the requested tags. (AND semantics is
   * deferred — most callers want "show me anything tagged X or Y".)
   */
  readonly tag?: string | ReadonlyArray<string>;
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
  /**
   * Opt-in prefix match. When true, every query token of 3+ chars is
   * matched as a prefix (FTS5 `"token"*`), so "timez" hits "timezone".
   * Off by default because prefix queries can match aggressively — a
   * three-character prefix can hit half the index.
   */
  readonly prefix?: boolean;
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

// ── Boundaries (cross-repo interaction map) ───────────────────────────

/**
 * A boundary edge records that a repo `provides` (owns / produces) or
 * `consumes` (depends on) a named contract — an event, endpoint, queue,
 * table, RPC, etc. Aggregated across repos via `sync`, the edges form a
 * dependency map: changing a contract in one app, the `consumes` edges
 * tell you which other apps it affects.
 *
 *   - "provides" = this repo is the owner / source of truth for the
 *     contract (the producer of an event, the server of an endpoint).
 *   - "consumes" = this repo depends on it (subscribes, calls, reads).
 */
export type BoundaryRole = "provides" | "consumes";

/**
 * Boundary lifecycle. Same trust spine as lore: agent-declared edges
 * land as `draft` (hidden from the default map until a human ratifies);
 * `active` is canonical; `deprecated` is retired but still findable so
 * historical edges aren't silently lost.
 */
export type BoundaryStatus = "draft" | "active" | "deprecated";

export interface BoundaryRow {
  readonly id: string;
  readonly repo: string;
  /** Normalised contract key (lowercased / hyphenated; see normaliseContract). */
  readonly contract: string;
  readonly role: BoundaryRole;
  /** Optional classifier: event | endpoint | queue | table | rpc | other. */
  readonly kind: string | null;
  readonly status: BoundaryStatus;
  /** Free-text note: which field/version/path, migration caveats, etc. */
  readonly detail: string | null;
  readonly source: string | null;
  readonly author: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface Boundary {
  readonly id: string;
  readonly repo: string;
  readonly contract: string;
  readonly role: BoundaryRole;
  readonly kind?: string;
  readonly status: BoundaryStatus;
  readonly detail?: string;
  readonly source?: string;
  readonly author?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
