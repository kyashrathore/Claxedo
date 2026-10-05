/// <reference types="bun" />
import { expect, test } from "bun:test"
import { machineId, placementId, projectId, type Machine, type Placement } from "@/server"
import { sessionMarker } from "./session-marker"

const box: Machine = { id: machineId("enr_box"), name: "build-box", online: true, isThisMachine: false, enrolled: true }
const folder: Placement = { id: placementId("ws_shots"), projectId: projectId("prj"), kind: "worktree", label: "shots", reachable: true, onThisMachine: false, machineId: machineId("enr_box") }

test("a session on another machine is marked by that machine's own name, with its folder beside it, never as Another machine", () => {
  expect(sessionMarker(folder, [box])).toEqual({ kind: "machine", name: "build-box", folder: "shots" })
  expect(sessionMarker({ ...folder, kind: "cloud", label: "payments" }, [box])).toEqual({ kind: "cloud", name: "payments" })
  expect(sessionMarker({ ...folder, onThisMachine: true, kind: "folder" }, [box])).toBeUndefined()
})
