/**
 * Public library surface. Consumers can:
 *
 *   import { openDb, addLore, suggestLore, searchLore, ... } from "lore-mcp";
 *
 * The MCP server and CLI both live behind separate bin entrypoints
 * (`lore-mcp` and `lore` respectively); this module is for embedding
 * the same logic in another Node process — e.g. an internal service
 * that ingests Slack/Confluence into the same SQLite store.
 */

export { openDb, defaultDbPath } from "./db/index.js";
export {
  addLore,
  approveLore,
  clampConfidence,
  deleteLore,
  deprecateLore,
  getLore,
  listDrafts,
  listRecent,
  listRepos,
  listTags,
  searchLore,
  supersedeLore,
  suggestLore,
  updateLore,
  verifyLore,
} from "./core/lore.js";
export { newIdeaId as newLoreId } from "./core/ids.js";
export type {
  AddLoreInput,
  Lore,
  LoreConfidence,
  LoreRow,
  LoreStatus,
  LoreSummary,
  SearchOptions,
  UpdateLoreInput,
} from "./db/types.js";
