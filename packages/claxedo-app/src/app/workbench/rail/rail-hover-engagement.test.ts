import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"

import { createHoverEngagement, railHeaderActionsBox } from "./rail-hover-engagement"

/**
 * Dispatches a real `focusout` at `from` with the handler bound to `host`, so
 * the handler sees the same `currentTarget`/`relatedTarget` pair the browser
 * gives it — the containment check it makes is only meaningful against real
 * nodes and a real dispatch.
 */
function focusOut(input: {
  host: HTMLElement
  from: HTMLElement
  to: HTMLElement | null
  handler: (event: FocusEvent) => void
}) {
  const listener = (event: Event) => input.handler(event as FocusEvent)
  input.host.addEventListener("focusout", listener)
  input.from.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: input.to }))
  input.host.removeEventListener("focusout", listener)
}

describe("createHoverEngagement", () => {
  test("pointer and focus both engage, and disengage immediately without a release delay", () => {
    createRoot((dispose) => {
      const engagement = createHoverEngagement()
      expect(engagement.engaged()).toBe(false)

      engagement.handlers.onPointerEnter()
      expect(engagement.engaged()).toBe(true)

      engagement.handlers.onPointerLeave()
      expect(engagement.engaged()).toBe(false)

      engagement.handlers.onFocusIn()
      expect(engagement.engaged()).toBe(true)
      dispose()
    })
  })

  test("focus moving between two controls inside the same host does not disengage", () => {
    createRoot((dispose) => {
      const engagement = createHoverEngagement()
      // The handler decides with a real `Node.contains` check, so the test
      // gives it real nodes.
      const hostNode = document.createElement("div")
      const insideNode = document.createElement("button")
      hostNode.append(insideNode)

      const sibling = document.createElement("button")
      hostNode.append(sibling)

      engagement.handlers.onFocusIn()
      focusOut({ host: hostNode, from: insideNode, to: sibling, handler: engagement.handlers.onFocusOut })
      expect(engagement.engaged()).toBe(true)

      focusOut({ host: hostNode, from: insideNode, to: null, handler: engagement.handlers.onFocusOut })
      expect(engagement.engaged()).toBe(false)
      dispose()
    })
  })

  test("a release delay keeps the affordance mounted for its own fade-out", async () => {
    await createRoot(async (dispose) => {
      const engagement = createHoverEngagement({ releaseDelayMs: 20 })
      engagement.handlers.onPointerEnter()
      engagement.handlers.onPointerLeave()
      expect(engagement.engaged()).toBe(true)

      // Re-entering during the fade cancels the pending release rather than
      // letting a queued timer unmount a re-hovered row.
      engagement.handlers.onPointerEnter()
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(engagement.engaged()).toBe(true)

      engagement.handlers.onPointerLeave()
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(engagement.engaged()).toBe(false)
      dispose()
    })
  })
})

describe("railHeaderActionsBox", () => {
  test("reserves exactly the box the mounted buttons occupy", () => {
    // `size-6` buttons in a `gap-0.5` row: 3 × 24px + 2 × 2px = 76px wide and
    // 24px tall, which is what a project header's cluster measures in the
    // running app — and the height that keeps the header 32px tall.
    expect(railHeaderActionsBox(3)).toEqual({ width: "4.75rem", height: "1.5rem" })
    // A workspace header adds the two agent shortcuts: 5 × 24px + 4 × 2px.
    expect(railHeaderActionsBox(5)).toEqual({ width: "8rem", height: "1.5rem" })
    expect(railHeaderActionsBox(0)).toEqual({ width: "0rem", height: "0rem" })
  })
})

describe("createHoverEngagement independent sources", () => {
  test("losing focus never withdraws an affordance the pointer still rests on", () => {
    createRoot((dispose) => {
      const engagement = createHoverEngagement()
      engagement.handlers.onPointerEnter()
      engagement.handlers.onFocusIn()
      engagement.handlers.onFocusOut(new FocusEvent("focusout", { relatedTarget: null }))
      expect(engagement.engaged()).toBe(true)
      engagement.handlers.onPointerLeave()
      expect(engagement.engaged()).toBe(false)
      dispose()
    })
  })

  test("leaving with the pointer never withdraws an affordance the keyboard is inside", () => {
    createRoot((dispose) => {
      const engagement = createHoverEngagement()
      engagement.handlers.onFocusIn()
      engagement.handlers.onPointerEnter()
      engagement.handlers.onPointerLeave()
      expect(engagement.engaged()).toBe(true)
      dispose()
    })
  })
})
