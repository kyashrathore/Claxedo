/// <reference types="bun" />
import { expect, test } from "bun:test"
import { machineId, placementId, projectId, type Machine, type Placement } from "@/server"
import type { WorkspaceName } from "@/cloud"
import { markerLabel, markerName, sessionMarker } from "./session-marker"

const box: Machine = { id: machineId("enr_box"), name: "build-box", online: true, isThisMachine: false, enrolled: true }
const folder: Placement = { id: placementId("ws_shots"), projectId: projectId("prj"), kind: "worktree", label: "shots", reachable: true, onThisMachine: false, machineId: machineId("enr_box") }

test("a session on another machine is marked by that machine's own name, with its folder beside it, never as Another machine", () => {
  expect(sessionMarker(folder, [box])).toEqual({ kind: "machine", name: "build-box", folder: "shots" })
  expect(sessionMarker({ ...folder, kind: "cloud", label: "payments" }, [box])).toEqual({ kind: "cloud", name: "payments" })
  expect(sessionMarker({ ...folder, onThisMachine: true, kind: "folder" }, [box])).toBeUndefined()
})

test("a cloud session's marker names its workspace once: an unnamed workspace reads Cloud workspace with its branch, never the word twice", () => {
  const t = ((key: string) => (key === "rail.marker.cloud" ? "Cloud workspace" : key)) as Parameters<typeof markerLabel>[0]
  const unnamed: Placement = { id: placementId("ws_cloud"), projectId: projectId("prj"), kind: "cloud", branch: "main", reachable: true, onThisMachine: false }
  expect(markerLabel(t, sessionMarker(unnamed, []) ?? { kind: "cloud" }, "Shop")).toBe("Cloud workspace · main")
  expect(markerLabel(t, sessionMarker({ ...unnamed, label: "payments" }, []) ?? { kind: "cloud" }, "Shop")).toBe("Cloud workspace · payments")
})

test("a cloud session's meta line names its workspace through the cloud naming, so an unnamed workspace never leaves the line empty", () => {
  const named: WorkspaceName = (name, branch) => name ?? ["Cloud workspace", branch].filter(Boolean).join(" · ")
  const unnamed: Placement = { id: placementId("ws_cloud"), projectId: projectId("prj"), kind: "cloud", reachable: true, onThisMachine: false }
  expect(markerName(named, sessionMarker(unnamed, []) ?? { kind: "cloud" })).toBe("Cloud workspace")
  expect(markerName(named, sessionMarker({ ...unnamed, branch: "main" }, []) ?? { kind: "cloud" })).toBe("Cloud workspace · main")
  expect(markerName(named, sessionMarker({ ...unnamed, label: "payments", branch: "main" }, []) ?? { kind: "cloud" })).toBe("payments")
  expect(markerName(named, sessionMarker(folder, [box]) ?? { kind: "cloud" })).toBe("build-box")
})
