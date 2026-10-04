/// <reference types="bun" />
import { expect, test } from "bun:test"
import { handoverTransition, SETTLED, type Handover } from "./handover"

const assigned = (serial: number, from: string | null, to: string | null, paneId = "p1") => ({ type: "assigned" as const, serial, paneId, from, to })

test("a pane that changes content keeps the outgoing content until the incoming one reveals", () => {
  const handing = handoverTransition(SETTLED, assigned(1, "a", "b"))
  expect(handing).toEqual({ kind: "handing", serial: 1, paneId: "p1", outgoing: "a", incoming: "b" })
  expect(handoverTransition(handing, { type: "revealed", serial: 1 })).toBe(SETTLED)
})

test("a reveal of an earlier handover leaves a newer one waiting", () => {
  const handing = handoverTransition(handoverTransition(SETTLED, assigned(1, "a", "b")), assigned(2, "b", "c"))
  expect(handing).toEqual({ kind: "handing", serial: 2, paneId: "p1", outgoing: "a", incoming: "c" })
  expect(handoverTransition(handing, { type: "revealed", serial: 1 })).toBe(handing)
})

test("going back to the outgoing content, or to an empty pane, settles at once", () => {
  const handing: Handover = handoverTransition(SETTLED, assigned(1, "a", "b"))
  expect(handoverTransition(handing, assigned(2, "b", "a"))).toBe(SETTLED)
  expect(handoverTransition(handing, assigned(2, "b", null))).toBe(SETTLED)
  expect(handoverTransition(SETTLED, assigned(1, null, "b"))).toBe(SETTLED)
})

test("a change in another pane starts its own handover from what that pane showed", () => {
  const handing = handoverTransition(handoverTransition(SETTLED, assigned(1, "a", "b")), assigned(2, "x", "y", "p2"))
  expect(handing).toEqual({ kind: "handing", serial: 2, paneId: "p2", outgoing: "x", incoming: "y" })
})
