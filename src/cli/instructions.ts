/**
 * The retrieval rule the user pastes into their agent's instructions
 * file. Kept here (not just in the README) so `lore print-claude-instructions`
 * can emit it deterministically and `lore doctor` can verify it later.
 *
 * Edit only with care — this is the agent-side trust contract.
 */
export const CLAUDE_INSTRUCTIONS = `Before non-trivial or context-sensitive code changes, search \`lore\` for
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

Call \`search_lore\` first with the repo name, subsystem, and kind of change.
Prefer records that are \`active\`, scoped to the current repo/team/tag,
not stale, medium/high confidence, and backed by a source.

Treat stale, low-confidence, source-less, deprecated, or conflicting
records as clues, not authority. If lore conflicts with the repo, tests,
or the user's explicit instruction, surface the conflict before proceeding.

Only call \`get_lore\` when the summary is not enough.

At the end of the task, call \`suggest_lore\` only if you discovered a
reusable convention, gotcha, decision, or service-specific rule that
would help future agents. Do not save temporary task state or speculation.`;

export function renderClaudeInstructions(): string {
  return CLAUDE_INSTRUCTIONS + "\n";
}
