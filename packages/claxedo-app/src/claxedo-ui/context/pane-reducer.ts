/**
 * Generic pane reducer aliases.
 *
 * Re-exports the terminal reducer under content-agnostic names so the
 * multi-pane system can reuse the same binary-tree logic without coupling
 * to terminal-specific naming.
 */

export {
  reduceTerminalTab as reducePaneTab,
  paneList,
  paneIncludes,
  paneReplaceId,
  paneFindPath,
  type TerminalTabState as PaneTabState,
  type TerminalTabAction as PaneTabAction,
  type Pane,
  type PaneDir,
} from "./terminal-reducer"
