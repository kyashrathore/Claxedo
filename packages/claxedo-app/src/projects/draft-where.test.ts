/// <reference types="bun" />
import { expect, test } from "bun:test"
import { machineId, placementId, projectId, type Placement, type PlacementKind } from "@/server"
import { creationOf, currentPlacement, groupedPlaces, whereEntries, worktreeRoots, type WhereEntry } from "./draft-where"

const project = projectId("prj_app")
const box = machineId("enr_box")

function placement(id: string, kind: PlacementKind, extra: Partial<Placement> = {}): Placement {
  return { id: placementId(id), projectId: project, kind, label: id, reachable: true, onThisMachine: false, ...extra }
}

const folder = placement("pl_folder", "folder", { onThisMachine: true })
const worktree = placement("pl_tree", "worktree", { onThisMachine: true })
const cloud = placement("ws_cloud", "cloud", { label: "payments" })
const remote = placement("pl_box", "folder", { machineId: box })
const otherProject = { ...placement("pl_other", "folder"), projectId: projectId("prj_other") }

function shape(entries: readonly WhereEntry[]) {
  return entries.map((entry) => `${entry.place}:${entry.placement.id}`)
}

test("every machine's folders and worktrees share one Machines group, the serving machine's first, then the cloud workspaces, for this project only", () => {
  const entries = whereEntries({ placements: [cloud, remote, worktree, otherProject, folder], projectId: project })
  expect(shape(entries)).toEqual(["machine:pl_folder", "machine:pl_tree", "machine:pl_box", "cloud:ws_cloud"])
  expect([...groupedPlaces(entries)]).toEqual(["machine", "cloud"])
})

test("one place means no group headers, and the web lists no pseudo-row when nothing is connected", () => {
  expect(groupedPlaces(whereEntries({ placements: [cloud], projectId: project })).size).toBe(0)
  expect(shape(whereEntries({ placements: [cloud], projectId: project }))).toEqual(["cloud:ws_cloud"])
  expect(shape(whereEntries({ placements: [], projectId: project }))).toEqual([])
})

test("a new worktree branches only from a folder the serving machine holds", () => {
  const entries = whereEntries({ placements: [folder, worktree, remote, cloud], projectId: project })
  expect(worktreeRoots(entries).map((root) => root.id)).toEqual([folder.id])
})

test("the chosen placement stays chosen while the catalog has not listed it yet; nothing else stands in for it", () => {
  const entries = whereEntries({ placements: [folder, cloud], projectId: project })
  expect(currentPlacement(entries, { kind: "placement", id: cloud.id })?.id).toBe(cloud.id)
  expect(currentPlacement(entries, { kind: "placement", id: placementId("ws_new"), pendingName: "checkout" })).toBeUndefined()
  expect(currentPlacement(entries, { kind: "newWorktree", root: folder.id })).toBeUndefined()
  expect(creationOf({ kind: "placement", id: folder.id })).toBeUndefined()
  expect(creationOf({ kind: "newWorktree", root: folder.id })).toBe("worktree")
})
