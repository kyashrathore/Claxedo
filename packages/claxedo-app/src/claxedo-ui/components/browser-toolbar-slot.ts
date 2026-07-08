import { createSignal } from "solid-js"

const [slot, setSlotInternal] = createSignal<HTMLElement | null>(null)

export const browserToolbarSlot = slot

export function setBrowserToolbarSlot(el: HTMLElement | null): void {
  setSlotInternal(el)
}
