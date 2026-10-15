/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import type { CloudWorkspaceRow } from "@/cloud"
import { placementId, projectId, type MachineTime, type MachineTimeWorkspace } from "@/server"
import { isRunningRow, listSandboxRows, sandboxRows, sandboxTotals } from "./sandbox-rows"

const MINUTE = 60_000
const small = { size: "small", vcpu: 2, memoryGb: 4, usdPerHour: 0.018 }
const large = { size: "large", vcpu: 8, memoryGb: 16, usdPerHour: 0.072 }

const timed = ({ id, ...patch }: Partial<Omit<MachineTimeWorkspace, "id">> & { id: string }): MachineTimeWorkspace => ({
  id: placementId(id),
  provider: "boat",
  providerLabel: "Boat",
  machineClass: "small",
  activeMs: 10 * MINUTE,
  ...patch,
})

const live = (id: string, state: CloudWorkspaceRow["state"], name?: string): CloudWorkspaceRow => ({
  id: placementId(id),
  projectId: projectId("prj_1"),
  ...(name ? { name } : {}),
  status: state,
  state,
})

const time = (workspaces: MachineTimeWorkspace[]): MachineTime => ({ since: 0, until: 1, activeMs: 0, running: 0, workspaces, providers: [] })

describe("sandboxRows", () => {
  test("a workspace that ran on two sizes is one row with both machines, its time and cost summed", () => {
    const rows = sandboxRows(time([
      timed({ id: "ws_a", machineClass: "large", rate: large, costUsd: 0.012, runningSince: 9 }),
      timed({ id: "ws_a", rate: small, costUsd: 0.003, lastStoppedAt: 5 }),
    ]), undefined)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: "ws_a", activeMs: 20 * MINUTE, runningSince: 9, lastStoppedAt: 5 })
    expect(rows[0]?.cost.kind).toBe("complete")
    expect(rows[0]?.cost.kind === "complete" ? rows[0].cost.usd : undefined).toBeCloseTo(0.015, 12)
    expect(rows[0]?.machines.map((machine) => machine.machineClass)).toEqual(["large", "small"])
  })

  test("running workspaces come first, then the most recently stopped, and a workspace still starting is a row of its own with no time", () => {
    const rows = sandboxRows(time([
      timed({ id: "ws_old", lastStoppedAt: 100 }),
      timed({ id: "ws_recent", lastStoppedAt: 300 }),
      timed({ id: "ws_run", runningSince: 50 }),
    ]), [live("ws_run", { kind: "ready" }, "Run"), live("ws_new", { kind: "starting" }, "New")])
    expect(rows.map((row) => [row.id, row.name, row.live?.state.kind, row.machines.length])).toEqual([
      ["ws_run", "Run", "ready", 1],
      ["ws_new", "New", "starting", 0],
      ["ws_recent", undefined, undefined, 1],
      ["ws_old", undefined, undefined, 1],
    ])
    expect(rows.map(isRunningRow)).toEqual([true, true, false, false])
    expect(rows[1]?.cost).toEqual({ kind: "none" })
  })

})

describe("sandboxRows pricing and filter", () => {
  test("a row is priced in full, at least in part, or not at all", () => {
    const rows = sandboxRows(time([
      timed({ id: "ws_part", rate: small, costUsd: 0.003, lastStoppedAt: 5 }),
      timed({ id: "ws_part", provider: "modal", providerLabel: "Modal", machineClass: "large" }),
      timed({ id: "ws_none", provider: "modal", providerLabel: "Modal", lastStoppedAt: 1 }),
    ]), [])
    expect(rows.map((row) => ({ id: row.id, cost: row.cost }))).toEqual([
      { id: placementId("ws_part"), cost: { kind: "partial", usd: 0.003 } },
      { id: placementId("ws_none"), cost: { kind: "unknown" } },
    ])
  })

  test("once the running list has loaded, a workspace it no longer lists is stopped whatever an earlier machine-time read says", () => {
    const rows = sandboxRows(time([timed({ id: "ws_stopped", runningSince: 1, lastStoppedAt: 5 }), timed({ id: "ws_on", runningSince: 2 })]), [live("ws_on", { kind: "ready" })])
    expect(rows.map((row) => ({ id: row.id, running: isRunningRow(row) }))).toEqual([
      { id: placementId("ws_on"), running: true },
      { id: placementId("ws_stopped"), running: false },
    ])
    expect(rows.find((row) => row.id === placementId("ws_stopped"))?.runningSince).toBeUndefined()
  })

  test("the running filter keeps only the rows still on", () => {
    const rows = sandboxRows(time([timed({ id: "ws_run", runningSince: 1 }), timed({ id: "ws_off", lastStoppedAt: 1 })]), undefined)
    const read = { time: true, live: true }
    expect(listSandboxRows(rows, "running", read)).toEqual({ kind: "rows", rows: [expect.objectContaining({ id: placementId("ws_run") })] })
    expect(listSandboxRows(rows, "all", read)).toMatchObject({ kind: "rows", rows: { length: 2 } })
  })
})

describe("listSandboxRows", () => {
  test("no rows is an empty range only when both the machine time and the running list were read", () => {
    expect(listSandboxRows([], "all", { time: true, live: true })).toEqual({ kind: "empty" })
    expect(listSandboxRows([], "running", { time: true, live: true })).toEqual({ kind: "empty" })
  })

  test("no rows under a failed or unfinished read claims nothing, so a refused read never reads as no sandbox ran", () => {
    expect(listSandboxRows([], "all", { time: false, live: true })).toEqual({ kind: "unknown" })
    expect(listSandboxRows([], "all", { time: true, live: false })).toEqual({ kind: "unknown" })
    expect(listSandboxRows([], "running", { time: false, live: false })).toEqual({ kind: "unknown" })
  })
})

describe("sandboxTotals", () => {
  test("sums the range's time and cost, counts the running rows, and prices the hour from the machines serving now", () => {
    const totals = sandboxTotals(sandboxRows(time([
      timed({ id: "ws_a", machineClass: "large", rate: large, costUsd: 0.012, runningSince: 9 }),
      timed({ id: "ws_a", rate: small, costUsd: 0.003 }),
      timed({ id: "ws_b", rate: small, costUsd: 0.006, activeMs: 20 * MINUTE, runningSince: 4 }),
      timed({ id: "ws_c", rate: small, costUsd: 0.001, lastStoppedAt: 2 }),
    ]), undefined))
    expect(totals).toMatchObject({ activeMs: 50 * MINUTE, running: 2 })
    expect(totals.cost.kind === "complete" ? totals.cost.usd : undefined).toBeCloseTo(0.022, 12)
    expect(totals.hourly.kind === "complete" ? totals.hourly.usd : undefined).toBeCloseTo(0.09, 12)
  })

  test("with nothing running the hour has no price, and a running machine with no published rate makes it unknown", () => {
    expect(sandboxTotals(sandboxRows(time([timed({ id: "ws_off" })]), [])).hourly).toEqual({ kind: "none" })
    expect(sandboxTotals(sandboxRows(time([timed({ id: "ws_run", provider: "modal", providerLabel: "Modal", runningSince: 1 })]), undefined)).hourly).toEqual({ kind: "unknown" })
    expect(sandboxTotals([])).toEqual({ activeMs: 0, cost: { kind: "none" }, running: 0, hourly: { kind: "none" } })
  })
})
