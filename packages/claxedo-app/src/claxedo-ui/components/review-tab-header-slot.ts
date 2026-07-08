import { createSignal } from "solid-js"

const [slot, setSlotInternal] = createSignal<HTMLElement | null>(null)

export const reviewTabHeaderSlot = slot

export function setReviewTabHeaderSlot(el: HTMLElement | null): void {
  setSlotInternal(el)
}
