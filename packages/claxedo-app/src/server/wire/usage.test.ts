/// <reference types="bun" />
import { expect, test } from "bun:test"
import { placementId, projectId } from "../ids"
import { machineTimeFromWire } from "./usage"

const rate = { size: "small", vcpu: 2, memoryGb: 4, usdPerHour: 0.018 }
const boat = { provider: "boat", label: "Boat", meter: "Boat bills per second while a sandbox runs.", source: { url: "https://docs.boat.dev/pricing", readOn: "2026-10-12" } }

test("a machine-time answer keeps its period, totals, priced and unpriced workspace rows and the providers' billing, and refuses one missing a number", () => {
  const body = {
    since: 1,
    until: 2,
    activeMs: 600_000,
    running: 1,
    workspaces: [
      { workspaceId: "ws_a", projectId: "prj_1", name: "Checkout", branch: "main", provider: "boat", providerLabel: "Boat", machineClass: "small", activeMs: 600_000, runningSince: 1, lastStoppedAt: 0, rate, costUsd: 0.003 },
      { workspaceId: "ws_b", name: "ws_b", provider: "modal", providerLabel: "Modal", machineClass: null, activeMs: 60_000 },
    ],
    providers: [{ ...boat, excludes: "nothing" }],
    extra: "x",
  }
  expect(machineTimeFromWire(body)).toEqual({
    since: 1,
    until: 2,
    activeMs: 600_000,
    running: 1,
    workspaces: [
      { id: placementId("ws_a"), projectId: projectId("prj_1"), name: "Checkout", branch: "main", provider: "boat", providerLabel: "Boat", machineClass: "small", activeMs: 600_000, runningSince: 1, lastStoppedAt: 0, rate, costUsd: 0.003 },
      { id: placementId("ws_b"), provider: "modal", providerLabel: "Modal", activeMs: 60_000 },
    ],
    providers: [{ ...boat, excludes: "nothing" }],
  })
  expect(() => machineTimeFromWire({ since: 1, until: 2, running: 0, workspaces: [], providers: [] })).toThrow()
  expect(() => machineTimeFromWire({ since: 1, until: 2, activeMs: "600000", running: 0, workspaces: [], providers: [] })).toThrow()
  expect(() => machineTimeFromWire({ since: 1, until: 2, activeMs: 0, running: 0 })).toThrow()
  expect(() => machineTimeFromWire({ ...body, workspaces: [{ workspaceId: "ws_a", provider: "boat", providerLabel: "Boat", activeMs: 1, rate }] })).toThrow()
  expect(() => machineTimeFromWire({ ...body, providers: [{ provider: "boat", label: "Boat" }] })).toThrow()
  expect(() => machineTimeFromWire(null)).toThrow()
})
