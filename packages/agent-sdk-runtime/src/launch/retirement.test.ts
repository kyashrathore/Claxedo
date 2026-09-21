import { expect, test } from "bun:test"
import { neverExecuted, retirementSettled, type RetirementResult } from "./retirement"
import type { SignalOutcome } from "./retirement"

const result = (over: Partial<RetirementResult> = {}): RetirementResult => ({
  leader: "exited",
  descendants: "unknown",
  signals: [],
  ...over,
})

const refused = (refusal: SignalOutcome["refusal"]): SignalOutcome => ({
  signal: "SIGKILL",
  scope: "group",
  delivered: false,
  refusal,
})

test("only an exited leader over a group that holds nothing settles", () => {
  expect(retirementSettled(result())).toBe(true)
  expect(retirementSettled(result({ descendants: "verified_clear" }))).toBe(true)

  // The descendant clause: a leader can exit over a group that still has members.
  expect(retirementSettled(result({ descendants: "owned" }))).toBe(false)
  expect(retirementSettled(result({ leader: "alive" }))).toBe(false)
  expect(retirementSettled(result({ leader: "unknown" }))).toBe(false)
  expect(retirementSettled(result({ error: { code: "exit_unverified", message: "x" } }))).toBe(false)
})

test("a refused signal keeps the resource, except the refusal that means it was already gone", () => {
  expect(retirementSettled(result({ signals: [refused("permission_denied")] }))).toBe(false)
  expect(retirementSettled(result({ signals: [refused("identity_mismatch")] }))).toBe(false)
  expect(retirementSettled(result({ signals: [refused("not_group_leader")] }))).toBe(false)
  expect(retirementSettled(result({ signals: [refused("identity_unverifiable")] }))).toBe(false)

  // ESRCH on the way in is the outcome this was asking for.
  expect(retirementSettled(result({ signals: [refused("exited")] }))).toBe(true)
  expect(retirementSettled(result({ signals: [{ signal: "SIGTERM", scope: "group", delivered: true }] }))).toBe(true)
})

test("every combination of leader and descendants agrees with the rule it states", () => {
  const leaders = ["exited", "alive", "unknown"] as const
  const descendants = ["verified_clear", "owned", "unknown"] as const
  for (const leader of leaders) {
    for (const item of descendants) {
      expect(retirementSettled(result({ leader, descendants: item })))
        .toBe(leader === "exited" && item !== "owned")
    }
  }
})

test("a launch whose payload never ran owns nothing", () => {
  expect(neverExecuted()).toEqual({ leader: "exited", descendants: "verified_clear", signals: [] })
  expect(retirementSettled(neverExecuted())).toBe(true)
})
