import { expect, test } from "vitest"
import { captureSandboxCheckpoint } from "./checkpoint-manager"

test("a missing checkpoint lease is a typed conflict", async () => {
  await expect(captureSandboxCheckpoint({
    workspaceId: "ws_1", request: {} as never,
    leaseStore: { get: async () => null } as never,
    target: async () => { throw new Error("must not call target") },
    snapshot: async () => { throw new Error("must not call snapshot") },
  })).rejects.toMatchObject({ code: "workspace_checkpoint_conflict", status: 409, retryable: false })
})

test("an unavailable checkpoint target is typed even when its reason says only busy", async () => {
  await expect(captureSandboxCheckpoint({
    workspaceId: "ws_1", request: {} as never,
    leaseStore: { get: async () => ({ status: "ready", persistence: { capture: "filesystem" } }) } as never,
    target: async () => ({ status: "unavailable", reason: "Busy" }),
    snapshot: async () => { throw new Error("must not call snapshot") },
  })).rejects.toMatchObject({ code: "workspace_checkpoint_unavailable", status: 503, retryable: true })
})
