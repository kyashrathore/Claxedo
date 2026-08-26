import { describe, expect, test } from "bun:test"
import { createRoot, flush } from "solid-js"

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

/**
 * Owns the engagement for one test. The root only CONSTRUCTS it: every handler
 * call is made from outside, because that is where the browser makes them —
 * a `pointerenter`/`focusin` listener runs in its own task, under no owner.
 * Solid 2 rejects a signal write from inside an owned scope, so driving the
 * handlers from within the root body would test a call the app never makes.
 */
function mountEngagement(input?: { releaseDelayMs?: number }) {
  let dispose: VoidFunction = () => {}
  const engagement = createRoot((disposer) => {
    dispose = disposer
    return createHoverEngagement(input)
  })
  return { engagement, dispose }
}

// Solid 2 stages a signal write until the next flush, so every synchronous
// assertion that follows a handler call flushes first. Reads after an `await`
// need no flush: the timed release's write is committed on the microtask after
// its callback, before the awaited continuation resumes.
describe("createHoverEngagement", () => {
  test("pointer and focus both engage, and disengage immediately without a release delay", () => {
    const { engagement, dispose } = mountEngagement()
    try {
      expect(engagement.engaged()).toBe(false)

      engagement.handlers.onPointerEnter()
      flush()
      expect(engagement.engaged()).toBe(true)

      engagement.handlers.onPointerLeave()
      flush()
      expect(engagement.engaged()).toBe(false)

      engagement.handlers.onFocusIn()
      flush()
      expect(engagement.engaged()).toBe(true)
    } finally {
      dispose()
    }
  })

  test("focus moving between two controls inside the same host does not disengage", () => {
    const { engagement, dispose } = mountEngagement()
    try {
      // The handler decides with a real `Node.contains` check, so the test
      // gives it real nodes.
      const hostNode = document.createElement("div")
      const insideNode = document.createElement("button")
      hostNode.append(insideNode)

      const sibling = document.createElement("button")
      hostNode.append(sibling)

      engagement.handlers.onFocusIn()
      focusOut({ host: hostNode, from: insideNode, to: sibling, handler: engagement.handlers.onFocusOut })
      flush()
      expect(engagement.engaged()).toBe(true)

      focusOut({ host: hostNode, from: insideNode, to: null, handler: engagement.handlers.onFocusOut })
      flush()
      expect(engagement.engaged()).toBe(false)
    } finally {
      dispose()
    }
  })

  test("a release delay keeps the affordance mounted for its own fade-out", async () => {
    const { engagement, dispose } = mountEngagement({ releaseDelayMs: 20 })
    try {
      engagement.handlers.onPointerEnter()
      engagement.handlers.onPointerLeave()
      flush()
      expect(engagement.engaged()).toBe(true)

      // Re-entering during the fade cancels the pending release rather than
      // letting a queued timer unmount a re-hovered row.
      engagement.handlers.onPointerEnter()
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(engagement.engaged()).toBe(true)

      engagement.handlers.onPointerLeave()
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(engagement.engaged()).toBe(false)
    } finally {
      dispose()
    }
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
