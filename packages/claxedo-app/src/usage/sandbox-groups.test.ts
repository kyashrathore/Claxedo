/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import type { CloudWorkspaceRow } from "@/cloud"
import { placementId, projectId, type MachineTime, type MachineTimeWorkspace } from "@/server"
import { listSandboxGroups, sandboxProjectGroups, sandboxProviderTotals } from "./sandbox-groups"
import { sandboxRows } from "./sandbox-rows"

const MINUTE = 60_000

const timed = ({ id, ...patch }: Partial<Omit<MachineTimeWorkspace, "id">> & { id: string }): MachineTimeWorkspace => ({
  id: placementId(id),
  provider: "cloudflare",
  providerLabel: "Cloudflare",
  activeMs: 10 * MINUTE,
  ...patch,
})

const live = (id: string, project: string): CloudWorkspaceRow => ({ id: placementId(id), projectId: projectId(project), status: { kind: "ready" }, state: { kind: "ready" } })

const time = (workspaces: MachineTimeWorkspace[]): MachineTime => ({ since: 0, until: 1, activeMs: 0, running: 0, workspaces, providers: [] })

describe("sandboxProjectGroups", () => {
  test("workspaces of one project are one group with their time and cost summed, in the rows' order", () => {
    const rows = sandboxRows(time([
      timed({ id: "ws_a", projectId: projectId("prj_hello"), costUsd: 0.001, lastStoppedAt: 3 }),
      timed({ id: "ws_b", projectId: projectId("prj_claxedo"), costUsd: 1.43, activeMs: 600 * MINUTE, lastStoppedAt: 2 }),
      timed({ id: "ws_c", projectId: projectId("prj_hello"), costUsd: 0.002, lastStoppedAt: 1 }),
      timed({ id: "ws_d", lastStoppedAt: 0 }),
    ]), [])
    const groups = sandboxProjectGroups(rows)
    expect(groups.map((group) => [group.projectId, group.rows.map((row) => row.id), group.activeMs, group.running])).toEqual([
      [projectId("prj_hello"), [placementId("ws_a"), placementId("ws_c")], 20 * MINUTE, false],
      [projectId("prj_claxedo"), [placementId("ws_b")], 600 * MINUTE, false],
      [undefined, [placementId("ws_d")], 10 * MINUTE, false],
    ])
    expect(groups[0]?.cost.kind === "complete" ? groups[0].cost.usd : undefined).toBeCloseTo(0.003, 12)
    expect(groups[2]?.cost).toEqual({ kind: "unknown" })
  })

  test("a project with any workspace on is running", () => {
    const rows = sandboxRows(time([timed({ id: "ws_on", projectId: projectId("prj_1"), runningSince: 1 }), timed({ id: "ws_off", projectId: projectId("prj_1") })]), [live("ws_on", "prj_1")])
    expect(sandboxProjectGroups(rows).map((group) => group.running)).toEqual([true])
  })
})

describe("listSandboxGroups", () => {
  test("the running filter keeps only the workspaces still on, grouped by project", () => {
    const rows = sandboxRows(time([timed({ id: "ws_run", projectId: projectId("prj_1"), runningSince: 1 }), timed({ id: "ws_off", projectId: projectId("prj_1"), lastStoppedAt: 1 })]), undefined)
    const read = { time: true, live: true }
    expect(listSandboxGroups(rows, "running", read)).toMatchObject({ kind: "groups", groups: [{ rows: [{ id: placementId("ws_run") }] }] })
    expect(listSandboxGroups(rows, "all", read)).toMatchObject({ kind: "groups", groups: [{ rows: { length: 2 } }] })
  })

  test("no rows is an empty range only when both the machine time and the running list were read", () => {
    expect(listSandboxGroups([], "all", { time: true, live: true })).toEqual({ kind: "empty" })
    expect(listSandboxGroups([], "running", { time: true, live: true })).toEqual({ kind: "empty" })
  })

  test("no rows under a failed or unfinished read claims nothing, so a refused read never reads as no sandbox ran", () => {
    expect(listSandboxGroups([], "all", { time: false, live: true })).toEqual({ kind: "unknown" })
    expect(listSandboxGroups([], "all", { time: true, live: false })).toEqual({ kind: "unknown" })
    expect(listSandboxGroups([], "running", { time: false, live: false })).toEqual({ kind: "unknown" })
  })
})

describe("sandboxProviderTotals", () => {
  test("each provider's machines are summed apart, the longest-running provider first", () => {
    const totals = sandboxProviderTotals(time([
      timed({ id: "ws_a", costUsd: 0.004 }),
      timed({ id: "ws_b", provider: "boat", providerLabel: "Boat", activeMs: 600 * MINUTE, costUsd: 1.43 }),
      timed({ id: "ws_c", costUsd: 0.002, activeMs: 5 * MINUTE }),
      timed({ id: "ws_d", provider: "modal", providerLabel: "Modal" }),
    ]))
    expect(totals.map((total) => [total.label, total.activeMs, total.cost.kind])).toEqual([
      ["Boat", 600 * MINUTE, "complete"],
      ["Cloudflare", 15 * MINUTE, "complete"],
      ["Modal", 10 * MINUTE, "unknown"],
    ])
    expect(totals[1]?.cost.kind === "complete" ? totals[1].cost.usd : undefined).toBeCloseTo(0.006, 12)
  })
})
