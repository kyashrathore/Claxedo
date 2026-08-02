import { createSignal, type Accessor } from "solid-js"

// A "portal slot" is a single mutable binding for one DOM mount point: some
// piece of persistent chrome (an L2 toolbar strip, a titlebar region) claims
// it on mount via `ref`, and content elsewhere in the tree portals into it
// via `<Portal mount={slot()}>`. There is exactly one binding per slot at a
// time — setting a new element replaces the previous one, it does not
// accumulate a list.
export type PortalSlot = readonly [get: Accessor<HTMLElement | null>, set: (el: HTMLElement | null) => void]

/**
 * Creates one independent portal slot. Each call returns its own signal —
 * calling this twice never shares state between the two results, so every
 * consumer that needs a distinct mount point calls it once and exports the
 * pair under a name that describes what mounts there.
 *
 * `name` is passed through to Solid's `createSignal` dev-tools name (shows
 * up in the Solid devtools signal graph); it has no other runtime effect.
 */
export function createPortalSlot(name: string): PortalSlot {
  const [slot, setSlotInternal] = createSignal<HTMLElement | null>(null, { name })
  const set = (el: HTMLElement | null): void => {
    setSlotInternal(el)
  }
  return [slot, set] as const
}

export const [browserToolbarSlot, setBrowserToolbarSlot] = createPortalSlot("browser-toolbar")
export const [processToolbarSlot, setProcessToolbarSlot] = createPortalSlot("process-toolbar")
export const [markdownFileActionsSlot, setMarkdownFileActionsSlot] = createPortalSlot("markdown-file-actions")

/**
 * B3.4 — review-toolbar L2 portal slot.
 *
 * The L2 header (`rail-layout.tsx → L2HeaderStrip`) registers a DOM
 * mount node here when its review contextual subtree mounts. The
 * review tab's `ReviewToolbar` reads the slot and, when set, renders
 * via `<Portal mount={slot}>` — moving the toolbar out of the tab
 * canvas and into the persistent L2 strip.
 *
 * When the slot is `null` (no L2 strip mounted, e.g. tests, or
 * pre-B3.4 layouts) the toolbar renders in its original position so
 * we degrade gracefully.
 */
export const [reviewToolbarSlot, setReviewToolbarSlot] = createPortalSlot("review-toolbar")

// Review view controls (expand/collapse-all + unified/split toggle). Mounted by
// the L2 strip immediately to the left of the Files/Changes/Processes navigator
// so the controls sit at the far right of the review header, independent of the
// toolbar body's internal flex layout.
export const [reviewControlsSlot, setReviewControlsSlot] = createPortalSlot("review-controls")

export const [reviewTabHeaderSlot, setReviewTabHeaderSlot] = createPortalSlot("review-tab-header")

// WorkGraph global-navigation panel slots. The shared WorkspacePanel renders a
// header tab strip and a body mount when a `workgraph-*` mode is active; the
// WorkGraph surface portals its "Needs you" / "Settings" tab controls into the
// header slot and the active view into the body slot. This keeps all WorkGraph
// state in the surface while reusing the one physical panel shell + toggle.
export const [workGraphPanelHeaderSlot, setWorkGraphPanelHeaderSlot] = createPortalSlot("workgraph-panel-header")
export const [workGraphPanelBodySlot, setWorkGraphPanelBodySlot] = createPortalSlot("workgraph-panel-body")

// components/titlebar/titlebar.tsx (legacy titlebar) claims these three mount points
// on render; components/session/session-header.tsx portals its search
// button and open-in-app controls into the center/right slots. This
// replaces a getElementById-based DOM-id string contract (left/center/right
// mount points) with a typed, compiler-checked one.
export const [titlebarLeftSlot, setTitlebarLeftSlot] = createPortalSlot("titlebar-left")
export const [titlebarCenterSlot, setTitlebarCenterSlot] = createPortalSlot("titlebar-center")
export const [titlebarRightSlot, setTitlebarRightSlot] = createPortalSlot("titlebar-right")
