/**
 * The detail pane's remembered width.
 *
 * It is a per-machine viewing preference, not catalog state, so it lives in
 * `localStorage` rather than travelling with the account. Every read and write
 * is guarded: a private window, a disabled storage partition or a quota-full
 * profile must cost the pane its memory, never its render.
 */
export const AGENT_PLUGIN_PANE_WIDTH_KEY = "claxedo.agent-plugins.detail-width"
export const AGENT_PLUGIN_PANE_MIN_WIDTH = 360
export const AGENT_PLUGIN_PANE_DEFAULT_WIDTH = 420
/** The pane never takes more than this share of the Directory's own width. */
export const AGENT_PLUGIN_PANE_MAX_FRACTION = 0.6

export function readPaneWidth(): number {
  try {
    const stored = Number(localStorage.getItem(AGENT_PLUGIN_PANE_WIDTH_KEY))
    if (!Number.isFinite(stored) || stored < AGENT_PLUGIN_PANE_MIN_WIDTH) return AGENT_PLUGIN_PANE_DEFAULT_WIDTH
    return Math.round(stored)
  } catch {
    return AGENT_PLUGIN_PANE_DEFAULT_WIDTH
  }
}

export function writePaneWidth(width: number) {
  try {
    localStorage.setItem(AGENT_PLUGIN_PANE_WIDTH_KEY, String(Math.round(width)))
  } catch {
    // A pane that cannot remember its width still resizes for this session.
  }
}
