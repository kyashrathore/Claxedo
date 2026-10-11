/// <reference types="bun" />
import { expect, test } from "bun:test"
import { machineTimeFromWire } from "./usage"

test("a machine-time answer keeps its period, milliseconds and running count, and refuses one missing a number", () => {
  expect(machineTimeFromWire({ since: 1, until: 2, activeMs: 600_000, running: 1, extra: "x" })).toEqual({ since: 1, until: 2, activeMs: 600_000, running: 1 })
  expect(() => machineTimeFromWire({ since: 1, until: 2, running: 0 })).toThrow()
  expect(() => machineTimeFromWire({ since: 1, until: 2, activeMs: "600000", running: 0 })).toThrow()
  expect(() => machineTimeFromWire(null)).toThrow()
})
