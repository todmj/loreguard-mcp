/**
 * Public library surface. Consumers can:
 *
 *   import { openDb, addLore, suggestLore, searchLore, ... } from "loreguard-mcp";
 *
 * The MCP server and CLI both live behind separate bin entrypoints
 * (`loreguard-mcp` and `loreguard` respectively); this module is for
 * embedding the same logic in another Node process — e.g. an internal
 * service that ingests Slack/Confluence into the same SQLite store.
 */

export { openDb, defaultDbPath } from "./db/index.js";
export {
  addLore,
  approveLore,
  clampConfidence,
  deleteLore,
  deprecateLore,
  getLore,
  getRejectionReason,
  listDrafts,
  listRecent,
  listRepos,
  listTags,
  pruneReadEvents,
  rejectLore,
  searchLore,
  searchLoreCount,
  supersedeLore,
  suggestLore,
  updateLore,
  verifyLore,
} from "./core/lore.js";
export { newLoreId } from "./core/ids.js";
export {
  addBoundary,
  approveBoundary,
  deprecateBoundary,
  findDependents,
  listBoundaries,
  listBoundaryDrafts,
  normaliseContract,
  rejectBoundary,
  suggestBoundary,
} from "./core/boundaries.js";
export type {
  AddLoreInput,
  Boundary,
  BoundaryRole,
  BoundaryStatus,
  Lore,
  LoreConfidence,
  LoreRow,
  LoreStatus,
  LoreSummary,
  SearchOptions,
  UpdateLoreInput,
} from "./db/types.js";
