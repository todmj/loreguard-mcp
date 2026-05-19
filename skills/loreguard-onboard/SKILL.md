---
name: loreguard-onboard
description: |
  Use this skill when the user types `/loreguard-onboard` (or asks "set up
  loreguard for this repo" / "onboard this repo to loreguard" / "what should
  be in lore for this repo?"). It runs a repo-aware onboarding interview
  that produces DRAFT lore records grounded in concrete repo signals
  (README, ADRs, recent commits, deprecation markers, in-flight migrations).
  Requires the loreguard-mcp MCP server to be configured. Uses these MCP
  tools: search_lore / get_lore / suggest_lore (core), and optionally
  report_conflict (when a candidate item contradicts existing lore) and
  record_absence (when the user confirms a topic has no team policy yet).
  All suggest_lore / report_conflict output lands as drafts — the human
  approves via `loreguard review` afterwards. record_absence markers
  self-expire (default 14 days) and don't need review.
---

# /loreguard-onboard — repo-aware onboarding for loreguard

A complement to the CLI's `loreguard induct` (which asks a fixed list of
10 generic questions without seeing the repo). This skill earns its keep
by **reading the repo first** so the questions and proposed drafts are
specific to *this* codebase, with source citations.

Three CLI paths fit different cold-start shapes — surface the right one
to the user up front:

| Path | Best for | Output |
|---|---|---|
| `loreguard induct` | quick, generic, no-agent | DRAFTS via fixed 10-Q interview |
| `/loreguard-onboard` (this skill) | repo-grounded, agent-driven, selective | DRAFTS with source citations + optional absence markers |
| `loreguard ingest-md <glob>` | bulk-import existing markdown (CLAUDE.md, ADRs, migration notes) | DRAFTS, one per H3 / bullet |

The skill is the *selective + grounded* path. If the user has 50 ADRs
and wants them as drafts in one shot, `ingest-md` is faster — point
them at it and consider it an upstream for this skill (you can still
follow up with curation in `loreguard review`).

## Hard rules

1. **Every lore record this skill produces is a DRAFT.** Call
   `suggest_lore` (or `report_conflict` for counter-claims — also drafts),
   never any approval path. The human reviews with `loreguard review`.
   Exception: `record_absence` does NOT create a draft — it records a
   self-expiring "we checked, no policy" marker. Different primitive,
   different gate (see rule 6).
2. **Every draft carries the tag `induction`** so it can be filtered later.
   Layer topic-specific extras as appropriate (`security`, `conventions`,
   `migrations`, `incident-lessons`, `invariants`, etc.). `report_conflict`
   counter-drafts are auto-tagged `conflict-report` by the server.
3. **Cite sources in the body.** When a draft comes from a file or commit,
   include a one-line reference at the top of the `body` — e.g.
   `Source: README.md L42–55` or `Source: commit abc1234 "migrate accounts → organisations"`.
   This is the trust signal a reviewer needs.
4. **Never put secrets, credentials, personal data, regulated data, or
   anything that looks like a token** into any lore record. If a candidate
   item contains something like that, skip it and tell the user why.
5. **Skip the obvious.** "We use TypeScript", "run the tests before
   committing", and other things a model already knows about a typical
   codebase belong in `CLAUDE.md` (or nowhere), not in lore. Aim for
   non-obvious, high-consequence knowledge.
6. **Use `record_absence` sparingly.** If the user explicitly confirms
   "we don't have a policy on X yet, and that's intentional", that's
   a legitimate absence marker — call `record_absence({ query: "<topic>",
   reason: "<why no policy>", repo: <repo> })`. Don't infer absence
   from "I didn't find anything in the README"; the user has to confirm
   it. Markers self-expire (14 days default) so they fade automatically
   if the team takes a stance later.
7. **Use `report_conflict` when you find a contradiction, not when you
   find a duplicate.** If `search_lore` returns an existing record and
   the source-of-truth you just read **disagrees** with it (e.g. README
   says "Argon2id", existing lore says "scrypt"), that's a `report_conflict`
   moment. If the existing record just covers the same topic without
   contradicting, leave it alone — `possibleConflicts` in search results
   handles benign overlap.

## Procedure

Follow these steps in order. Confirm with the user as the comments
indicate.

### Step 1 — confirm scope

Detect the current repo's short name (from `git config --get remote.origin.url`
or, failing that, from the working directory name). Confirm with the user:

> "I'll onboard `<repo-name>` to loreguard. Anything I should add to
> that, or remove? (e.g. `payments-svc, auth-svc` for cross-repo notes)"

Capture the final `repos` array — every draft created in this session
will carry it.

### Step 2 — survey the repo

Read these sources, in this order. Stop short of full-file reads when
you can — skim for signals.

1. **`CLAUDE.md` / `AGENTS.md` / `.claude/CLAUDE.md`** (any of these
   agent-instruction files): **highest-priority source.** These already
   contain content the team has hand-curated for agents — sections
   like "Things That Catch People Out", "Conventions", "Gotchas",
   "Architectural decisions", "Migrations", and similar are designed
   for exactly the kind of content loreguard captures. Treat each
   H2/H3 subsection (or each bullet under such a heading) as a
   candidate. Your job is to **triage durability** — not just
   transcribe the file verbatim. If a bullet reads as task-specific or
   transient, skip it; if it reads as "this is how things are here
   and will be in six months", capture it.
2. **`README.md`** — flag anything mentioning: "deprecated", "DO NOT USE",
   "WARNING", "legacy", "see also <ADR>", "incident", architectural
   choices, naming conventions, env vars with surprising defaults.
3. **`docs/`, `docs/adrs/`, `docs/architecture/`, `ADRs/`, `decisions/`,
   `.architecture/`** — if any exist, scan titles and final-decision
   sections. ADRs are the cleanest source of "decisions that aren't
   obvious from code".
4. **`MIGRATIONS.md` / `migrations/` / `db/migrations/`** — in-flight
   migrations are gold for lore. Look for "TODO", recent file dates,
   companion code that handles both old + new schemas.
5. **Top-level `package.json` / `pyproject.toml` / `go.mod` / `Cargo.toml`** —
   service name, peer-repo dependencies that suggest cross-repo
   conventions worth capturing.
6. **`git log --oneline -50`** — recent commit subjects often hint at:
   in-flight migrations ("migrate X to Y"), deprecations ("remove
   legacy Z"), incident fixes ("fix INC-NNN: …"), policy decisions.
7. **Grep for `// DEPRECATED`, `// TODO: remove`, `// WARNING:`, `// HACK:`** —
   these often mark non-obvious project knowledge.

### Step 3 — surface candidate drafts

Build a list of 5–10 *candidate* drafts grounded in what you found.
Present them to the user as a numbered list with the source citation:

> Found these candidate items. Want me to draft any of them as lore?
>
>   1. **Don't touch `legacy/auth.ts` except for security fixes.** Use
>      `requireSession()` for new auth gates. *(Source: README.md L42–55;
>      grep finds 12 active call sites of `requireSession`.)*
>   2. **In-flight migration: accounts → organisations.** New code uses
>      `org_id`; reporting still joins on `account_id`. *(Source: commit
>      a4f12c0 + migrations/0017_accounts_to_orgs.sql.)*
>   3. **Webhook retries cap at 2h backoff** to avoid downstream DoS.
>      *(Source: docs/adrs/0009-webhook-retry-cap.md, INC-411.)*
>   …
>
> Reply with the numbers to draft (e.g. `1, 3, 5`) or skip with `none`.
> I can also propose more items if I missed anything.

Skip items that are:

- generic programming advice the model already knows
- obvious from a single file's contents
- task-specific or session-specific
- anything containing apparent secrets / PII / regulated data
- already covered by an existing lore record (run `search_lore` for
  near-duplicate titles before proposing)

### Step 4 — draft via `suggest_lore`

For each item the user picks, call `suggest_lore` with this shape:

```ts
suggest_lore({
  title: "<short title — what is the rule / fact?>",
  summary: "<one-paragraph summary, stands alone>",
  body: "Source: <file/line or commit sha or doc path>\n\n<full detail / reasoning / evidence>\n\n(onboarded via /loreguard-onboard, <iso date>)",
  repos: <array confirmed in Step 1>,
  tags: ["induction", <topic-specific extras>],
  source: <PR/ADR/incident URL if you found one>,
  confidence: <"medium" if source URL is present, else "low">,
  team: <if obvious from CODEOWNERS or similar>
})
```

Drafts can't claim `high` confidence regardless — that invariant is
enforced server-side. Don't try.

After each call, note the returned `id` and any `possibleDuplicates`
the server flagged. If `possibleDuplicateCount > 0` or
`possibleDuplicates` is non-empty, tell the user before continuing:

> "Draft `<new-id>` created. Loreguard flagged 2 possible duplicates:
> `<id1>`, `<id2>`. Worth reviewing those alongside this one."

### Step 5 — wrap up

When the user is done picking, output a final summary:

> Created N drafts in `<repo>`:
>
>   - `<id1>`  <title1>
>   - `<id2>`  <title2>
>   …
>
> Counter-drafts (from `report_conflict`, if any):
>
>   - `<id3>`  challenges `<existingId>`  <one-line observation>
>
> Absence markers (from `record_absence`, if any):
>
>   - `<query>` — `<reason>` (expires in 14 days)
>
> Next steps:
>   - `loreguard review` — interactive triage of the drafts
>   - `loreguard hooks install` — opt-in: a Stop-hook nudges you to
>     review pending drafts at session end so they don't rot in the
>     queue (one-time-per-session, never nags)
>
> Drafts are invisible to default search until approved. Absence
> markers surface only on zero-hit searches matching the same
> normalised query.

If the user wants to keep iterating, loop back to Step 3 with a
different angle (e.g. "now let's look at the test suite for
authoritative-checks lore", or "let's scan for incident-lesson signals
in the issues tracker").

## Out of scope for this skill

- **Don't promote, deprecate, or supersede** records. Those are CLI-only
  by design.
- **Don't bulk-import** existing docs as lore yourself. Onboarding via
  this skill is *selective* — the value is human judgement on what's
  worth capturing, not volume. If the user wants bulk, point them at
  `loreguard ingest-md <glob>` (which creates one DRAFT per H3 or
  bullet) and let them curate via `loreguard review`.
- **Don't enable restricted records** (`includeRestricted` / setting
  `restricted: true`). If the user wants restricted lore, they author
  it via the CLI with `loreguard add --restricted`.
- **Don't claim contradictions you can't prove.** If `search_lore`
  returns existing records that overlap (`possibleConflicts` populated),
  that's the runtime overlap heuristic — surface it but let the human
  decide. Only call `report_conflict` when a source-of-truth you just
  read explicitly disagrees with the existing record (see Hard rule 7).
- **Don't blanket-record absences.** A `record_absence` marker is only
  warranted when the user confirms "the team has intentionally not
  taken a stance on X". Inferring absence from "I didn't find anything"
  would seed wrong markers that mislead the next agent.
- **Don't install the Stop-hook on the user's behalf.** Mention it
  exists at wrap-up so they can opt in (`loreguard hooks install`),
  but installing it silently changes their `.claude/settings.json` —
  that's their decision.
