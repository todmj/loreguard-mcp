/**
 * MCP trust-boundary helpers for restricted records.
 *
 * `search_lore` already env-gates restricted retrieval via
 * `LOREGUARD_ALLOW_RESTRICTED_MCP`. Without a matching gate on `get_lore(id)`,
 * any agent in possession of an id (a stale audit line, a prior message,
 * a CLI screenshot) could fetch the body and bypass the search gate.
 * These helpers close that asymmetry: when the gate is off and the
 * record is restricted, `get_lore` returns a minimal refusal shape
 * (no title, no body, no metadata) and records `blocked: "restricted"`
 * in the audit log.
 */

export interface RestrictedRefusal {
  readonly id: string;
  readonly restricted: true;
  readonly error: "restricted";
  readonly hint: string;
}

/**
 * Build the refusal payload returned by `get_lore` when the gate blocks
 * a restricted record. Deliberately omits title / summary / body / source /
 * timestamps — the agent already knows the id (it had to, to ask), but it
 * shouldn't learn anything else.
 */
export function redactRestricted(id: string): RestrictedRefusal {
  return {
    id,
    restricted: true,
    error: "restricted",
    hint: "Set LOREGUARD_ALLOW_RESTRICTED_MCP=1 to allow MCP access to restricted lore.",
  };
}

/**
 * Decide whether a `get_lore` response should be redacted. Pure function
 * of (record, env) so tests can drive it without spinning up the server.
 *
 * Returns true when:
 *   - the record exists and is restricted, AND
 *   - the env gate is NOT set to "1".
 */
export function shouldGateRestrictedGet(
  lore: { readonly restricted: boolean } | null,
  env: NodeJS.ProcessEnv,
): boolean {
  if (!lore) return false;
  if (!lore.restricted) return false;
  return env["LOREGUARD_ALLOW_RESTRICTED_MCP"] !== "1";
}

/**
 * Strip the `possibleConflicts` field from each search hit before it
 * leaves the MCP boundary. The conflict heuristic (shared repo + tag)
 * is useful for human triage in `loreguard search`, but surfacing it to
 * an LLM agent tends to cost more tokens (the agent treats the hint as
 * authoritative and tries to "resolve" the alleged conflict) than the
 * heuristic earns. The field is removed wholesale rather than
 * downgraded so a curious agent can't infer its existence either.
 *
 * Exported separately so a unit test can pin the contract without
 * spinning the stdio server.
 */
export function stripPossibleConflicts<
  T extends { readonly possibleConflicts?: ReadonlyArray<string> },
>(hits: ReadonlyArray<T>): Array<Omit<T, "possibleConflicts">> {
  return hits.map(({ possibleConflicts: _ignored, ...rest }) => rest);
}
