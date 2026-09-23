/**
 * The Directory's shared chrome.
 *
 * Four class strings that more than one surface in this folder has to agree on.
 * They live together so a row in the pane and a row in the MCP list cannot
 * drift apart into two nearly-identical shapes, which is what happened while
 * each file carried its own copy.
 */

/** An inset row inside the detail pane: skills, MCP servers, empty states. */
export const ROW = "rounded-lg border border-border-weak-base bg-surface-raised-base px-2.5 py-2"

/** A section label inside the detail pane. */
export const HEADING = "text-11-medium uppercase tracking-wide text-text-weaker"

/** A read-only fact chip: a harness, an environment. */
export const CHIP = "rounded-full border border-border-weak-base px-2 py-px text-11-medium text-text-base"

/** A quiet square button whose whole content is one icon. */
export const GHOST_ICON_BUTTON =
  "grid shrink-0 place-items-center rounded-md text-text-weak hover:bg-surface-raised-base hover:text-text-base disabled:text-text-weaker"
