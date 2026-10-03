import { describe, expect, test } from "bun:test"
import { machineId, placementId, projectId, sessionId, type SessionRow } from "@/server"
import { activityPlacement } from "./activity-placement"

const local = machineId("local")
const remote = machineId("remote")
const row: SessionRow = { ref: { sessionId: sessionId("session"), projectId: projectId("project"), placementId: placementId("placement") }, title: "Conversation", createdAt: 1, updatedAt: 1 }

describe("activity placement context", () => {
  test("shows the canonical machine name and reader-relative local or remote icon", () => {
    expect(activityPlacement({ ...row, placement: { kind: "local", machineName: "Laptop" } }, undefined, "Unavailable")).toEqual({ icon: "monitor", name: "Laptop" })
    expect(activityPlacement({ ...row, placement: { kind: "machine", machineId: remote, machineName: "Build machine" } }, local, "Unavailable")).toEqual({ icon: "server", name: "Build machine" })
    expect(activityPlacement({ ...row, placement: { kind: "machine", machineId: local, machineName: "Laptop" } }, local, "Unavailable")).toEqual({ icon: "monitor", name: "Laptop" })
  })

  test("uses only the cloud name that the authorized row supplies", () => {
    expect(activityPlacement({ ...row, placement: { kind: "cloud", cloudName: "Cloud workspace" } }, local, "Unavailable")).toEqual({ icon: "cloud", name: "Cloud workspace" })
    expect(activityPlacement({ ...row, placement: { kind: "cloud" } }, local, "Unavailable")).toEqual({ icon: "cloud", name: "Unavailable" })
  })

  test("a known identity cannot fill absent canonical placement or display metadata", () => {
    expect(activityPlacement({ ...row, placement: { kind: "machine", machineId: local } }, local, "Unavailable")).toEqual({ icon: "monitor", name: "Unavailable" })
    expect(activityPlacement(row, local, "Unavailable")).toEqual({ icon: "circle-alert", name: "Unavailable" })
  })
})
