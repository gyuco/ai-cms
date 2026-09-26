/**
 * The content tools of the agent (E9.1), the ones TECHNICAL §7.5 lists. They are the same
 * tools for the native engine and for the CLI over MCP (TECHNICAL §7.1).
 */
import { listNodesTool, readNodeTool } from './nodes.ts';
import {
  createPageTool,
  deleteNodeTool,
  moveNodeTool,
  updateBlocksTool,
  updateMetaTool,
} from './pages.ts';
import { publishTool, updateLayoutTool, updateMenuTool, uploadAssetTool } from './site.ts';

export { listNodesTool, readNodeTool } from './nodes.ts';
export {
  createPageTool,
  deleteNodeTool,
  moveNodeTool,
  pageTools,
  updateBlocksTool,
  updateMetaTool,
} from './pages.ts';
export {
  publishTool,
  siteTools,
  updateLayoutTool,
  updateMenuTool,
  uploadAssetTool,
} from './site.ts';
export {
  afterWrite,
  nodeName,
  saveOptions,
  type ContentContext,
  type ContentExtra,
  type ContentServices,
  type ContentSession,
  type ContentTool,
  type PageCheck,
  type WriteResult,
} from './context.ts';

/** Reading the site before changing it: what the agent sees, and what it can change. */
export const readTools = [listNodesTool, readNodeTool] as const;

/** Everything the content agent can do. */
export const contentTools = [
  ...readTools,
  createPageTool,
  updateBlocksTool,
  updateMetaTool,
  moveNodeTool,
  deleteNodeTool,
  updateLayoutTool,
  updateMenuTool,
  uploadAssetTool,
  publishTool,
] as const;
