/**
 * Shared types between the DB layer, core operations, the CLI, and the MCP
 * server. Kept narrow on purpose — surface area changes are migrations.
 */

export interface IdeaRow {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly author: string | null;
  readonly team: string | null;
  readonly confidential: 0 | 1;
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_verified_at: string | null;
}

/**
 * Public-shaped Idea — strings normalised, repos + tags joined in.
 * This is what the core layer returns and what the MCP tools serialise.
 */
export interface Idea {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly author?: string;
  readonly team?: string;
  readonly confidential: boolean;
  readonly repos: ReadonlyArray<string>;
  readonly tags: ReadonlyArray<string>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastVerifiedAt?: string;
}

/**
 * Lighter-weight projection used by `search` — full body deliberately
 * omitted so the LLM doesn't pull the entire archive into context on every
 * hit. Use `get_idea(id)` to fetch the body on demand.
 */
export interface IdeaSummary {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly author?: string;
  readonly team?: string;
  readonly confidential: boolean;
  readonly repos: ReadonlyArray<string>;
  readonly tags: ReadonlyArray<string>;
  readonly updatedAt: string;
  readonly lastVerifiedAt?: string;
  /** FTS rank, lower = more relevant. */
  readonly score?: number;
}

export interface SearchOptions {
  readonly query?: string;
  readonly repo?: string;
  readonly tag?: string;
  readonly since?: string; // ISO date — only ideas updated on/after this
  readonly includeConfidential?: boolean;
  readonly limit?: number;
}

export interface AddIdeaInput {
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly author?: string;
  readonly team?: string;
  readonly repos?: ReadonlyArray<string>;
  readonly tags?: ReadonlyArray<string>;
  readonly confidential?: boolean;
}
