/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import type { CloudWorkspaceRow } from "@/cloud"
import { placementId, projectId, type MachineTime, type MachineTimeWorkspace } from "@/server"
import { cloudCost, cloudRows } from "./cloud-rows"

const MINUTE = 60_000
const rate = { size: "small", vcpu: 2, memoryGb: 4, usdPerHour: 0.018 }

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

describe("cloudRows", () => {
  test("keeps the server's order, attaches the live row of a running workspace, and adds workspaces still starting after them", () => {
    const running = timed({ id: "ws_run", runningSince: 5, rate, costUsd: 0.003 })
    const ended = timed({ id: "ws_old", name: "Old" })
    const rows = cloudRows(time([running, ended]), [live("ws_run", { kind: "ready" }, "Run"), live("ws_new", { kind: "starting" }, "New")])
    expect(rows.map((row) => [row.key, row.name, row.time?.id, row.live?.state.kind])).toEqual([
      ["ws_run boat small", "Run", "ws_run", "ready"],
      ["ws_old boat small", "Old", "ws_old", undefined],
      ["ws_new", "New", undefined, "starting"],
    ])
    expect(rows.map((row) => row.running)).toEqual([true, false, true])
  })

  test("a workspace that ran on two sizes is two rows, and before the cloud catalog has loaded the machine time's running mark counts", () => {
    const rows = cloudRows(time([timed({ id: "ws_a", machineClass: "large", runningSince: 9 }), timed({ id: "ws_a", machineClass: "small" })]), undefined)
    expect(rows.map((row) => row.key)).toEqual(["ws_a boat large", "ws_a boat small"])
    expect(rows.map((row) => row.running)).toEqual([true, false])
  })

  test("once the cloud catalog has loaded, a workspace it no longer lists is stopped even while the last machine-time read says running since", () => {
    const rows = cloudRows(time([timed({ id: "ws_stopped", runningSince: 9 }), timed({ id: "ws_run", runningSince: 9 })]), [live("ws_run", { kind: "ready" })])
    expect(rows.map((row) => [row.id, row.running])).toEqual([[placementId("ws_stopped"), false], [placementId("ws_run"), true]])
  })

  test("before the machine time has loaded, the live rows are the table", () => {
    expect(cloudRows(undefined, [live("ws_x", { kind: "ready" })]).map((row) => row.id)).toEqual([placementId("ws_x")])
  })
})

describe("cloudCost", () => {
  test("sums the priced rows and names the providers whose time has no published rate", () => {
    const cost = cloudCost([
      timed({ id: "ws_a", rate, costUsd: 0.003 }),
      timed({ id: "ws_b", rate, costUsd: 0.006, activeMs: 20 * MINUTE }),
      timed({ id: "ws_c", provider: "modal", providerLabel: "Modal", activeMs: 7 * MINUTE }),
    ])
    expect(cost.usd).toBeCloseTo(0.009, 12)
    expect(cost).toMatchObject({ pricedMs: 30 * MINUTE, unpricedMs: 7 * MINUTE, unpricedProviders: ["Modal"] })
    expect(cloudCost([])).toEqual({ usd: 0, pricedMs: 0, unpricedMs: 0, unpricedProviders: [] })
  })
})
