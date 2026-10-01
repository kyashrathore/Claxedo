import { expect, test } from "bun:test"
import { projectId } from "@/server"
import { planProjectColorAssignment } from "./project-colors"

for (const configurationAvailable of [false, true]) {
  test(`rail colors use local preferences with server configuration ${configurationAvailable ? "available" : "unavailable"}`, () => {
    const id = projectId("prj_1")
    const requested = new Map<string, string>()
    const plan = planProjectColorAssignment({ projects: [{ id }], colors: {}, requested, pick: () => "pink", configurationAvailable } as Parameters<typeof planProjectColorAssignment>[0])
    expect(plan.assignments).toEqual([{ id, color: "pink" }])
    expect(plan.remoteUpdates).toEqual(configurationAvailable ? [{ id, color: "pink" }] : [])
    expect(requested.size).toBe(configurationAvailable ? 1 : 0)
  })
}
