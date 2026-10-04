/// <reference types="bun" />
import { expect, test } from "bun:test"
import { machineId, placementId, projectId, type Placement, type PlacementKind } from "@/server"
import { creationOf, currentPlacement, groupedPlaces, localRoot, newCloudName, whereEntries, type WhereEntry } from "./draft-where"

const project = projectId("prj_app")
const here = machineId("mch_here")
const box = machineId("mch_box")

function placement(id: string, kind: PlacementKind, extra: Partial<Placement> = {}): Placement {
  return { id: placementId(id), projectId: project, kind, label: id, reachable: true, ...extra }
}

const folder = placement("pl_folder", "folder")
const worktree = placement("pl_tree", "worktree")
const cloud = placement("ws_cloud", "cloud", { label: "payments" })
const remote = placement("pl_box", "folder", { machineId: box })
const otherProject = { ...placement("pl_other", "folder"), projectId: projectId("prj_other") }

function shape(entries: readonly WhereEntry[]) {
  return entries.map((entry) => (entry.kind === "connectComputer" ? "connect" : `${entry.place}:${entry.placement.id}`))
}

test("a desktop lists this computer's folder first, then its worktrees, the cloud workspaces and the machines, for this project only", () => {
  const entries = whereEntries({ placements: [cloud, remote, worktree, otherProject, folder], projectId: project, thisMachine: here, machineConnected: false })
  expect(shape(entries)).toEqual(["computer:pl_folder", "computer:pl_tree", "cloud:ws_cloud", "machine:pl_box"])
  expect([...groupedPlaces(entries)]).toEqual(["computer", "cloud", "machine"])
  expect(localRoot(entries)?.id).toBe(placementId("pl_folder"))
})

test("a placement on this desktop's own enrollment is this computer, not a machine", () => {
  const enrolled = placement("pl_enrolled", "folder", { machineId: here })
  expect(shape(whereEntries({ placements: [enrolled], projectId: project, thisMachine: here, machineConnected: true }))).toEqual(["computer:pl_enrolled"])
})

test("the web with no connected machine offers to connect this computer above its cloud workspaces", () => {
  const entries = whereEntries({ placements: [cloud], projectId: project, thisMachine: undefined, machineConnected: false })
  expect(shape(entries)).toEqual(["connect", "cloud:ws_cloud"])
  expect([...groupedPlaces(entries)]).toEqual(["computer", "cloud"])
  expect(localRoot(entries)).toBeUndefined()
})

test("the web with a connected machine, or before it knows, lists no connect row, and a machine's folder is never this computer", () => {
  expect(shape(whereEntries({ placements: [cloud, remote], projectId: project, thisMachine: undefined, machineConnected: true }))).toEqual(["cloud:ws_cloud", "machine:pl_box"])
  expect(shape(whereEntries({ placements: [cloud], projectId: project, thisMachine: undefined, machineConnected: undefined }))).toEqual(["cloud:ws_cloud"])
})

test("one place means no group headers", () => {
  expect(groupedPlaces(whereEntries({ placements: [cloud], projectId: project, thisMachine: undefined, machineConnected: true })).size).toBe(0)
  expect(groupedPlaces(whereEntries({ placements: [folder, worktree], projectId: project, thisMachine: here, machineConnected: undefined })).size).toBe(0)
})

test("the current placement is the chosen one while listed, else the first listed; new workspaces are creations", () => {
  const entries = whereEntries({ placements: [folder, cloud], projectId: project, thisMachine: here, machineConnected: undefined })
  expect(currentPlacement(entries, { kind: "placement", id: cloud.id })?.id).toBe(cloud.id)
  expect(currentPlacement(entries, { kind: "placement", id: placementId("pl_gone") })?.id).toBe(folder.id)
  expect(currentPlacement([], { kind: "placement", id: folder.id })).toBeUndefined()
  expect(creationOf({ kind: "placement", id: folder.id })).toBeUndefined()
  expect(creationOf({ kind: "newWorktree" })).toBe("worktree")
  expect(creationOf({ kind: "newCloud", name: "payments" })).toBe("cloud")
})

test("a new cloud workspace needs a non-blank name, trimmed", () => {
  expect(newCloudName("  ")).toBeUndefined()
  expect(newCloudName(" payments ")).toEqual({ kind: "newCloud", name: "payments" })
})
