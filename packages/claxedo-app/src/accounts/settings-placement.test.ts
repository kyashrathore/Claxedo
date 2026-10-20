/// <reference types="bun" />
import { expect, test } from "bun:test"
import { placementId, projectId, ServerError, type Placement, type Project, type ProjectId } from "@/server"
import { settingsPlacement } from "./settings-placement"

function project(id: string, name: string, fields: Partial<Project> = {}): Project {
  return { id: projectId(id), name, available: true, createdAt: 1, updatedAt: 1, ...fields }
}

function folder(id: string, project: string): Placement {
  return { id: placementId(id), projectId: projectId(project), kind: "folder", label: id, reachable: true, onThisMachine: true }
}

function placedIn(...placements: readonly Placement[]) {
  return (project: ProjectId) => placements.find((placement) => placement.projectId === project)
}

test("settings placement: projects still loading, or failing to load, say so rather than claiming there is no project", () => {
  expect(settingsPlacement({ kind: "loading" }, placedIn())).toEqual({ kind: "loading" })
  const error = new ServerError({ class: "network", message: "The server could not be reached" })
  expect(settingsPlacement({ kind: "failed", error }, placedIn())).toEqual({ kind: "failed", error })
})

test("settings placement: no project at all is its own state", () => {
  expect(settingsPlacement({ kind: "ready", data: [] }, placedIn())).toEqual({ kind: "noProject" })
})

test("settings placement: the first available project with a placement answers, by its primary placement", () => {
  const data = [project("prj_a", "Alpha", { available: false }), project("prj_b", "Beta")]
  expect(settingsPlacement({ kind: "ready", data }, placedIn(folder("ws_a", "prj_a"), folder("ws_b", "prj_b")))).toEqual({ kind: "ready", placementId: placementId("ws_b"), label: "Beta" })
})

test("settings placement: projects none of which can answer name the first project and why", () => {
  const gone = project("prj_a", "Alpha", { available: false, missingCheckout: { directory: "/work/alpha" } })
  expect(settingsPlacement({ kind: "ready", data: [gone, project("prj_b", "Beta")] }, placedIn(folder("ws_a", "prj_a")))).toEqual({
    kind: "unavailable",
    project: "Alpha",
    why: { kind: "folderMissing", directory: "/work/alpha" },
  })
  expect(settingsPlacement({ kind: "ready", data: [project("prj_c", "Cloud", { available: false })] }, placedIn())).toEqual({
    kind: "unavailable",
    project: "Cloud",
    why: { kind: "workspaceUnavailable" },
  })
  expect(settingsPlacement({ kind: "ready", data: [project("prj_d", "Unplaced")] }, placedIn())).toEqual({ kind: "unavailable", project: "Unplaced", why: { kind: "workspaceUnavailable" } })
})
