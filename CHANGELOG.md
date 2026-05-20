# Changelog

All notable changes to **loreguard-mcp**. Format roughly follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project
itself is pre-1.0 so semver promises are best-effort.

## [Unreleased]

_Nothing is tagged yet. The first public cut will be **v0.1.0**;
everything below ships in that release. The initial-scope vs
added-since split is kept for the changelog reader's benefit, not as
a version boundary._

### Added — agent-facing MCP surface

- **`report_conflict`** — agents can flag code-vs-lore disagreement.
  Creates a DRAFT counter-record linked to the original via
  `conflictsWith` (one-way; the original is never mutated by the
  agent). Reviewer triages via `loreguard review`. Distinct from the
  runtime `possibleConflicts` heuristic — this is explicit,
  persisted, evidence-backed disagreement.
- **`record_absence`** — agents can record "the team has no policy
  here" so future agents don't re-search the same gap. Self-expiring
  (default 14 days, max 365). MCP write is **off by default** in
  this release (`LOREGUARD_ALLOW_MCP_ABSENCE=1` to enable); the CLI
  `loreguard absent record|list` always works. Search responses
  surface an active marker as `absence_marker: { reason, ... }`
  alongside an empty `results` array.
- **Structured length errors** — `suggest_lore` and `report_conflict`
  now return `{ error: "summary_too_long" | "title_too_long",
  provided, max, suggested_cut, hint }` on over-cap input, instead
  of zod's opaque max-cap rejection. Agents can paste `suggested_cut`
  back as a corrected retry without a human round-trip.
- **`next` coach on zero-hit searches** — when `search_lore` returns
  empty AND no active absence_marker, the response includes a
  one-paragraph `next` field nudging three behaviours in priority
  order: `record_absence` if the gap is durable, `suggest_lore` at
  task end if you discover something, and retry without the `repo`
  filter for cross-repo conventions. Cheap; converts dead-ends into
  productive next steps at zero extra round trips.
- **WHEN-first tool descriptions** — the `description` field on each
  MCP tool now opens with **when to call**, not what the tool does.
  Acts as an ambient retrieval rule that works across skills that
  have zero loreguard awareness; the CLAUDE.md retrieval rule
  remains as belt.

### Added — search & retrieval

- **bm25 column weights** (title 3.0, summary 2.0, body 1.0) — title
  hits outrank body hits for the same query.
- **Opt-in prefix mode** — `prefix: true` (MCP) / `--prefix` (CLI)
  matches query tokens of 3+ chars as FTS5 prefixes. Off by default.
- **Multi-tag ANY-of** — `tag` accepts a string or `string[]`.
- **`includeSuperseded` surfaced** across MCP schema, CLI flag, and
  the README — core already honoured it; v0.1 just plumbed it through.
- **`possibleConflicts` overlap-heuristic** (formerly `conflicts`) on
  search hits when two active records share a repo + tag. CLI-only;
  stripped from MCP responses to avoid LLMs over-resolving the hint.
- **Always-OR FTS query parsing** + parser bounded by H1/H2 in
  ingest-md.

### Added — onboarding / cold-start

- **`loreguard setup`** — one-command bootstrap: register the MCP
  server with Claude Code, append the retrieval rule to CLAUDE.md
  (HTML-marker wrapped for idempotency), install
  `/loreguard-onboard` into `~/.claude/skills/`, and **detect
  cold-start sources** (CLAUDE.md, AGENTS.md, ADR dirs, top-level
  docs) with a [4/4] nudge toward the right next action — the skill
  by default, `loreguard induct` when the skill isn't installed,
  `loreguard ingest-md` as the bulk-mechanical fallback. Per-step
  opt-outs via `--skip-mcp`, `--skip-claude-md`, `--skip-skill`,
  `--skip-corpus-nudge`. `--dry-run` shows the plan without changes.
- **`/loreguard-onboard` skill** — repo-aware Claude onboarding
  interview that reads README/ADRs/migrations/recent commits and
  surfaces candidate drafts with source citations. CLAUDE.md /
  AGENTS.md / `.claude/CLAUDE.md` listed as the highest-priority
  survey source.
- **`loreguard induct`** — 10-question interview with `--short=5`
  subset. Drafts only; tagged `induction`; 90-day `reviewAfter`.
- **`loreguard demo`** — five illustrative records (including a
  draft and a stale record) tagged `demo`, with `--clean` for
  tag-based undo.
- **`loreguard ingest-md <glob>`** — bulk Markdown → drafts with
  section / tag / repo / source / dry-run flags; filename deny-list
  excludes README/LICENSE/CHANGELOG/CONTRIBUTING/etc.; content-shape
  scoring suppresses noise.

### Added — team workflow

- **`loreguard sync export/import`** — PR-reviewable Markdown
  round-trip in `.loreguard/<id>.md`. SQLite stays canonical;
  `.md` files are the sync artifact. Safe-import with `--force`
  and `--dry-run`; id/enum validation on incoming files.
- **`loreguard export --json`** — single-document JSON export
  (envelope `{ schemaVersion: 1, exportedAt, records }`, stable
  ordering).
- **`loreguard sync export --clean`** — remove stale `<id>.md`
  files (id-pattern guarded; hand-written `.md` files preserved)
  for deterministic mirror exports.

### Added — operations & visibility

- **`loreguard stats`** — local read-tracking aggregations: top-cited
  records, retirement candidates (active + no reads in N days),
  recent activity binned by event kind. `--evidence` pivots the
  audit log to show the actual queries that hit each top-cited
  record (stream-parsed; safe on large logs). `--json` for machine
  output. `LOREGUARD_NO_TELEMETRY=1` opts out of read tracking.
- **`loreguard hooks install`** — Claude Code SessionStart hook that
  nudges the user to run `loreguard review` once per session when
  pending drafts exist.
- **`loreguard audit`** — human-readable / `--raw` views of
  `~/.loreguard/audit.jsonl`. Audit shape is **per-tool sanitised**
  (lengths, not text, for `suggest_lore` summary/body and
  `record_absence` query/reason).
- **`loreguard doctor`** — health-check: DB perms, FTS index, audit
  log, restricted-MCP gate, version.
- **`rejection_reason` capture** — `loreguard reject <id> --reason
  "..."` and the interactive review prompt; reason lands on the
  `rejected` event payload. `getRejectionReason()` exported.

### Added — docs & positioning

- **Tagline reframed** as "Team-ratified knowledge for AI coding
  agents" — memory says what one session believes; loreguard says
  what the team has reviewed and approved.
- **"What deserves lore?"** section with explicit good-lore / bad-lore
  lists.
- **"Why not just CLAUDE.md? And why not generic agent memory?"**
  three-column comparison keyed on the trust source.
- **`docs/PRINCIPLES.md`** + cross-repo retrieval rule in the
  CLAUDE.md instructions.
- **`docs/SECURITY.md`** — explicit per-tool audit-row shape, the
  `report_conflict`-against-restricted refusal, read-tracking
  defaults, stop-hook safety.
- **`docs/DATA-FLOW.md`** — ASCII diagram + paths under
  `~/.loreguard/`.

### Changed

- **Product renamed** — package `loreguard-mcp`; CLI binary
  `loreguard`; MCP server binary `loreguard-mcp`. The noun "lore"
  stays for records (`LoreSummary`, `addLore`, `search_lore`, the
  SQL `lore` table, `lore.db` filename) — loreguard is what guards
  the lore.
- **Data directory** — `~/.lore/` → `~/.loreguard/`. Env vars
  `LORE_*` → `LOREGUARD_*` (hard rename, no fallback — only the
  initial single-user install existed at the time).
- **GitHub repo** — `todmj/lore-mcp` → `tmj-90/loreguard-mcp`
  (collapses two renames: the package rename and the subsequent
  GitHub account rename). All README install paths, package.json
  URLs, and JSDoc examples updated.
- **Summary cap** — `summary` field bumped from 500 → 800 chars.
  Real-usage feedback: 500 forced a teaser-shaped summary that
  required a follow-up `get_lore` to decide relevance; 800 fits one
  real paragraph including the *why*.
- **MCP `get_lore` on restricted records** — env-gated by
  `LOREGUARD_ALLOW_RESTRICTED_MCP` (same gate as `search_lore`).
  Default returns a minimal refusal (no title / summary / body);
  audits `blocked: "restricted"`.
- **`possibleConflicts` overlap field** — renamed from `conflicts`
  to be honest about what the heuristic proves (shared scope, not
  contradiction). CLI marker reads "⚠ possibly conflicts with …".
- **`loreguard stats` window labels** — section headers now reflect
  the actual `--since-days` / `--quiet-for-days` values rather than
  hardcoding "90 days" / "180 days" / "30 days" when the caller
  overrode them.

### Fixed

- **`suggest_lore` validation masking** — over-cap inputs used to
  fail through zod's max-cap path and surface as "body is undefined"
  upstream. Now structured `{ error, provided, max, suggested_cut }`.
- **External-review correctness pass** — public-API hardening +
  trust-gate clarifications.
- **Markdown frontmatter parser robustness** — H1/H2 boundaries
  respected; always-OR FTS to fix near-miss searches.

### Security

- **`get_lore` restricted gate** closes the asymmetry where an agent
  with a known id could fetch the body even with `includeRestricted`
  defaulted off in `search_lore`.
- **`report_conflict` against restricted records** is always refused,
  regardless of the env gate, with a structured response. Restricted
  records can be revised by humans via `loreguard update` /
  `loreguard supersede`; agents can't draft against them.
- **Audit log per-tool sanitisation** — `summary_lore` / lore body
  text never leaves the in-memory request; `record_absence` query /
  reason captured as character counts only.

### Initial scope (carried into v0.1.0)

Trust gate, MCP surface, human-approval flow, restricted handling,
audit log boundary, FTS search, 5-minute demo walkthrough, lifecycle
commands.
