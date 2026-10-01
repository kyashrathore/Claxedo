import { describe, expect, test } from "vitest"
import { controlBus, type ControlPlaneEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import { configureWorkspaceSupervisorOptions } from "../workspace/supervisor/options"
import { emitProvision } from "./provision-events"

function capture() {
  const events: ControlPlaneEvent[] = []
  return { events, cleanup: controlBus.subscribe((event) => events.push(event)) }
}

function owners(sandboxOwner: (workspaceId: string) => Promise<string>) {
  configureWorkspaceSupervisorOptions({ server_url: "http://127.0.0.1:1", machineOwnerUserId: "local", sandboxOwner })
}

describe("sandbox provision events", () => {
  test("emits provision event with workspace, its owner, and extra metadata", async () => {
    owners(async (workspaceId) => (workspaceId === "ws-emit-1" ? "user_owner" : "user_other"))
    const tracker = capture()

    await emitProvision({ id: "ws-emit-1", org_id: "org-emit-1" }, "cloning", { message: "https://github.com/test/repo" })
    tracker.cleanup()

    expect(tracker.events).toEqual([{
      type: "provision",
      workspaceId: "ws-emit-1",
      orgId: "org-emit-1",
      ownerUserId: "user_owner",
      step: "cloning",
      message: "https://github.com/test/repo",
      ts: expect.any(Number),
    }])
  })

  test("a workspace whose owner cannot be resolved still rings its step, naming no owner", async () => {
    owners(async (workspaceId) => {
      throw new Error(`workspace ${workspaceId} has no owner to deliver accounts for`)
    })
    const tracker = capture()

    await emitProvision({ id: "ws-ownerless", org_id: "org-emit-1" }, "error", { message: "driver exhausted" })
    tracker.cleanup()

    expect(tracker.events).toHaveLength(1)
    expect(tracker.events[0]).toMatchObject({ type: "provision", workspaceId: "ws-ownerless", step: "error", message: "driver exhausted" })
    expect(tracker.events[0]).not.toHaveProperty("ownerUserId")
  })
})
