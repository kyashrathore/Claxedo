import { expect, test } from "vitest"
import { createSandboxManager } from "@claxedo/sandbox-manager"
import { createMemoryLeaseStore, sandboxLease } from "@claxedo/sandbox-manager/stores/memory"
import { sandboxRelayTargetLookup } from "./sandbox-relay-target"

test("resolver fences stale and missing routing identities against the current address", async () => {
  const leaseStore = createMemoryLeaseStore([sandboxLease({ workspaceId: "ws_1", sandboxId: "s_1", hostId: "host_1", url: "https://new.test", routingId: "current" })])
  const sandboxManager = { target: async () => {
    const lease = await leaseStore.get("ws_1")
    return lease?.status === "ready" ? lease : { status: "unavailable", reason: "runtime_lease_not_ready" }
  } } as unknown as ReturnType<typeof createSandboxManager>
  const lookup = sandboxRelayTargetLookup({ sandboxManager })
  for (const routingId of ["old", undefined]) {
    expect(await lookup({ workspaceId: "ws_1", hostId: "host_1", routingId })).toEqual({ found: false, code: "runtime_access_token_invalid" })
  }
  expect(await lookup({ workspaceId: "ws_1", hostId: "host_1", routingId: "current" })).toMatchObject({ found: true, baseUrl: "https://new.test" })
  await leaseStore.update("ws_1", 1, { status: "stopped" })
  expect(await lookup({ workspaceId: "ws_1", hostId: "host_1", routingId: "current" })).toEqual({ found: false, code: "runtime_access_token_invalid" })
  await leaseStore.release("ws_1")
  expect(await lookup({ workspaceId: "ws_1", hostId: "host_1", routingId: "current" })).toEqual({ found: false, code: "runtime_access_token_invalid" })
})
