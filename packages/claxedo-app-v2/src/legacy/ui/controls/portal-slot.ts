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
export const [fileHeaderActionsSlot, setFileHeaderActionsSlot] = createPortalSlot("file-header-actions")

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

// `app/workbench/rail/workbench-shell-header.tsx` claims these three mount
// points on render; `features/session/ui/components/session-header.tsx`
// portals its search button into the center slot and the Share control into
// the right one. A typed contract in place of the getElementById DOM-id
// strings this replaced.
export const [titlebarLeftSlot, setTitlebarLeftSlot] = createPortalSlot("titlebar-left")
export const [titlebarCenterSlot, setTitlebarCenterSlot] = createPortalSlot("titlebar-center")
export const [titlebarRightSlot, setTitlebarRightSlot] = createPortalSlot("titlebar-right")
