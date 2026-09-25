import { expect, test } from "bun:test"
import type { RetirementResult } from "../../launch"
import { createUnsettledLaunches } from "./unsettled-launches"

const UNSETTLED: RetirementResult = { leader: "unknown", descendants: "unknown", signals: [], error: { code: "ownership_unverified", message: "ps timed out" } }
const SETTLED: RetirementResult = { leader: "exited", descendants: "unknown", signals: [] }

function launch(outcomes: RetirementResult[]) {
  const exits = new Set<(error: Error) => void>()
  let disposals = 0
  return {
    dispose: async () => outcomes[Math.min(disposals++, outcomes.length - 1)]!,
    onExit: (listener: (error: Error) => void) => {
      exits.add(listener)
      return () => exits.delete(listener)
    },
    exit: () => { for (const listener of exits) listener(new Error("exited")) },
    disposals: () => disposals,
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test("a launch whose retirement did not settle is retired again when its leader exits, and forgotten once that settles", async () => {
  let settled = 0
  const unsettled = createUnsettledLaunches(() => { settled++ })
  const probe = launch([SETTLED])
  unsettled.hold(probe, UNSETTLED)
  expect(unsettled.results()).toEqual([UNSETTLED])
  probe.exit()
  await tick()
  expect({ results: unsettled.results(), settled }).toEqual({ results: [], settled: 1 })
})

test("a sweep retries every held launch and keeps the ones that still do not settle", async () => {
  const unsettled = createUnsettledLaunches(() => {})
  const stuck = launch([UNSETTLED, SETTLED])
  const done = launch([SETTLED])
  unsettled.hold(stuck, UNSETTLED)
  unsettled.hold(done, UNSETTLED)
  await unsettled.sweep()
  expect(unsettled.results()).toEqual([UNSETTLED])
  await unsettled.sweep()
  expect(unsettled.results()).toEqual([])
  expect(stuck.disposals()).toBe(2)
})

test("a settled retirement is never held", () => {
  const unsettled = createUnsettledLaunches(() => {})
  unsettled.hold(launch([SETTLED]), SETTLED)
  expect(unsettled.results()).toEqual([])
})
