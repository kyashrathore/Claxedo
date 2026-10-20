/// <reference types="bun" />
import { expect, test } from "bun:test"
import { machineId, placementId, projectId, type GitStatus, type Machine, type Placement } from "@/server"
import { readsBranch, sessionEnvironment, type BranchRead } from "./environment"

const here: Machine = { id: machineId("enr_here"), name: "laptop", online: true, isThisMachine: true, enrolled: true }
const box: Machine = { id: machineId("enr_box"), name: "build-box", online: false, isThisMachine: false, enrolled: true }
const folder: Placement = { id: placementId("ws_app"), projectId: projectId("prj"), kind: "folder", label: "app", path: "/Users/ada/app", branch: "main", reachable: true, onThisMachine: true }
const status = (branch?: string): GitStatus => ({ ...(branch ? { branch } : {}), ahead: 0, behind: 0, staged: [], unstaged: [] })
const read = (branch: BranchRead) => sessionEnvironment({ placement: folder, machines: [here, box], projectName: "Shop", branch })

test("a folder on this computer reads as This computer with the project's name, its path and the live branch over the catalog's", () => {
  expect(read({ kind: "ready", status: status("feature/cards") })).toEqual({
    where: { kind: "thisComputer" },
    worktree: false,
    folder: "Shop",
    path: "/Users/ada/app",
    branch: { kind: "named", name: "feature/cards" },
  })
})

test("until git answers, or when it cannot, the branch is the catalog's; a checkout with no branch is detached, and none known is unknown", () => {
  expect(read({ kind: "loading" }).branch).toEqual({ kind: "named", name: "main" })
  expect(read({ kind: "failed" }).branch).toEqual({ kind: "named", name: "main" })
  expect(read({ kind: "ready", status: status() }).branch).toEqual({ kind: "detached" })
  expect(sessionEnvironment({ placement: { ...folder, branch: undefined }, machines: [], projectName: undefined, branch: { kind: "skipped" } }).branch).toEqual({ kind: "unknown" })
})

test("another machine is named by its own name and its state, and a worktree by its own label", () => {
  const remote: Placement = { ...folder, kind: "worktree", label: "cards", onThisMachine: false, machineId: machineId("enr_box"), reachable: false }
  const environment = sessionEnvironment({ placement: remote, machines: [here, box], projectName: "Shop", branch: { kind: "skipped" } })
  expect(environment.where).toEqual({ kind: "machine", name: "build-box", state: "offline" })
  expect([environment.worktree, environment.folder]).toEqual([true, "cards"])
  expect(sessionEnvironment({ placement: remote, machines: [here, { ...box, online: true, paused: true }], projectName: "Shop", branch: { kind: "skipped" } }).where).toEqual({ kind: "machine", name: "build-box", state: "paused" })
})

test("an asleep cloud workspace is never asked for its branch, so reading the card cannot wake it", () => {
  const asleep: Placement = { id: placementId("ws_cloud"), projectId: projectId("prj"), kind: "cloud", lifecycle: "asleep", label: "payments", branch: "main", reachable: false, onThisMachine: false }
  expect(readsBranch(asleep)).toBe(false)
  expect(readsBranch({ ...asleep, lifecycle: "live", reachable: true })).toBe(true)
  expect(sessionEnvironment({ placement: asleep, machines: [], projectName: "Shop", branch: { kind: "skipped" } }).where).toEqual({ kind: "cloud", name: "payments", lifecycle: "asleep" })
})
