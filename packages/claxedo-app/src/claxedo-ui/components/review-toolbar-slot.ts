/**
 * B3.4 — review-toolbar L2 portal slot.
 *
 * The L2 header (`rail-layout.tsx → L2HeaderStrip`) registers a DOM
 * mount node here when its review contextual subtree mounts. The
 * review tab's `ReviewToolbar` reads the slot and, when set, renders
 * via `<Portal mount={slot}>` — moving the toolbar out of the tab
 * canvas and into the persistent L2 strip.
 *
 * When the slot is `undefined` (no L2 strip mounted, e.g. tests, or
 * pre-B3.4 layouts) the toolbar renders in its original position so
 * we degrade gracefully.
 */

import { createSignal } from "solid-js"

const [slot, setSlotInternal] = createSignal<HTMLElement | null>(null)

export const reviewToolbarSlot = slot

export function setReviewToolbarSlot(el: HTMLElement | null): void {
  setSlotInternal(el)
}
