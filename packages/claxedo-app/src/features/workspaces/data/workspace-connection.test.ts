import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { configureAppPortsForTest } from "@/app/integrations/test-support/app-ports-stub"
import {
  __workspaceConnectionInternals as internals,
  acquireWorkspaceConnection,
  connectionPlacement,
  isWorkspaceConnecting,
  isWorkspaceReady,
  markWorkspaceReconnected,
  markWorkspaceReconnecting,
  retryWorkspaceConnection,
  workspaceConnection,
  workspaceOffline,
  workspacePlacement,
} from "./workspace-connection"
import type { WorkspaceConnectionInfo } from "@/platform/runtime/agent/workspace-relay-connection"

beforeEach(() => configureAppPortsForTest())
afterEach(() => internals.reset())

describe("workspace connection authority", () => {
  const runtimeReadyFetch: typeof fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.includes("/api/workspace/resolve")) {
      return new Response(JSON.stringify({ workspaceId: "ws_cloud_late", kind: "cloud", status: "ready" }), {
        headers: { "content-type": "application/json" },
      })
    }
    return new Response("{}", { headers: { "content-type": "application/json" } })
  }

  const relayInfo = (input: Partial<WorkspaceConnectionInfo> = {}): WorkspaceConnectionInfo => ({
    access: "cloud",
    backing: "cloud-vm",
    workspaceId: "ws_relay",
    role: "viewer",
    relayUrl: "https://relay.example.test",
    runtimeAccessToken: "token",
    tokenExpiresAt: Date.now() + 60_000,
    ...input,
  })

  test("local workspaces are synthesized ready immediately (no relay backing)", () => {
    createRoot((dispose) => {
      const handle = acquireWorkspaceConnection({ workspaceId: "ws_local", kind: "local" })
      expect(isWorkspaceReady("ws_local")).toBe(true)
      expect(workspaceConnection("ws_local")?.status).toBe("ready")
      expect(connectionPlacement("ws_local")).toEqual({ state: "role-known", workspaceId: "ws_local", role: "owner" })
      expect(workspacePlacement("ws_local")).toEqual({
        workspaceId: "ws_local",
        hosting: "workspace",
        transport: "loopback",
        role: "owner",
      })
      handle.release()
      dispose()
    })
  })

  test("relay-backed workspaces start connecting from frame zero (no blank fall-through)", () => {
    createRoot((dispose) => {
      // The drive loop hits the network (prepareUserHostedRuntime) and resolves
      // later — we only assert the SYNCHRONOUS initial state set inside acquire,
      // which is what kills the blank fall-through frame. `status` is the
      // invariant; the exact phase advances as the (real) loop emits.
      acquireWorkspaceConnection({ workspaceId: "ws_uh", kind: "user-hosted", request: runtimeReadyFetch })
      const state = workspaceConnection("ws_uh")
      expect(state?.status).toBe("connecting")
      expect(connectionPlacement("ws_uh")).toEqual({ state: "role-pending", workspaceId: "ws_uh" })
      expect(workspacePlacement("ws_uh")).toBeUndefined()
      expect(isWorkspaceConnecting("ws_uh")).toBe(true)
      dispose()
    })
  })

  test("relay connection info promotes role placement and refresh can change roles", () => {
    createRoot((dispose) => {
      acquireWorkspaceConnection({ workspaceId: "ws_relay", kind: "user-hosted", request: runtimeReadyFetch })
      internals.applyWorkspaceConnectionInfo(relayInfo())

      expect(connectionPlacement("ws_relay")).toEqual({ state: "role-known", workspaceId: "ws_relay", role: "viewer" })
      expect(workspacePlacement("ws_relay")).toMatchObject({
        workspaceId: "ws_relay",
        hosting: "workspace",
        transport: "workspace-relay",
        role: "viewer",
      })

      internals.applyWorkspaceConnectionInfo(relayInfo({ role: "editor" }))
      expect(connectionPlacement("ws_relay")).toEqual({ state: "role-known", workspaceId: "ws_relay", role: "editor" })
      expect(workspacePlacement("ws_relay")?.role).toBe("editor")
      dispose()
    })
  })

  test("recently ready user-hosted workspaces stay ready across reload while health revalidates", () => {
    createRoot((dispose) => {
      internals.rememberRecentReady("ws_warm_uh")

      acquireWorkspaceConnection({ workspaceId: "ws_warm_uh", kind: "user-hosted", request: runtimeReadyFetch })

      expect(isWorkspaceReady("ws_warm_uh")).toBe(true)
      expect(workspaceConnection("ws_warm_uh")?.status).toBe("ready")
      dispose()
    })
  })

  test("refines fallback user-hosted acquires to cloud when inventory resolves later", () => {
    createRoot((dispose) => {
      acquireWorkspaceConnection({ workspaceId: "ws_cloud_late", kind: "user-hosted", request: runtimeReadyFetch })
      expect(workspaceConnection("ws_cloud_late")?.kind).toBe("user-hosted")

      acquireWorkspaceConnection({
        workspaceId: "ws_cloud_late",
        kind: "cloud",
        directory: "workspace:ws_cloud_late",
        request: runtimeReadyFetch,
      })

      expect(workspaceConnection("ws_cloud_late")?.kind).toBe("cloud")
      expect(workspaceConnection("ws_cloud_late")?.phase).toBe("acquiring_sandbox")
      expect(workspaceConnection("ws_cloud_late")?.status).toBe("connecting")
      dispose()
    })
  })

  test("ref-counts: N acquires share ONE entry; entry survives until last release", () => {
    createRoot((dispose) => {
      const a = acquireWorkspaceConnection({ workspaceId: "ws_shared", kind: "local" })
      const b = acquireWorkspaceConnection({ workspaceId: "ws_shared", kind: "local" })
      const c = acquireWorkspaceConnection({ workspaceId: "ws_shared", kind: "local" })
      expect(workspaceConnection("ws_shared")?.refs).toBe(3)

      a.release()
      b.release()
      // Two released, one outstanding — refs decremented, entry still present.
      expect(workspaceConnection("ws_shared")?.refs).toBe(1)
      expect(workspaceConnection("ws_shared")?.status).toBe("ready")

      c.release()
      // Last release schedules DEBOUNCED teardown, so the entry is still present
      // (refs 0) until the timer fires — this is what survives fast pane swaps.
      expect(workspaceConnection("ws_shared")?.refs).toBe(0)
      dispose()
    })
  })

  test("a second acquire on the same relay-backed workspace increments the shared ref to 2", () => {
    // The connection AUTHORITY is not the cause of the "second pane refs stuck
    // at 1" symptom (e2e core-panes-split-tabs behavior 19): a second acquire
    // for the same relay-backed workspaceId fans into the one entry and bumps
    // refs. The stuck-at-1 cause is a CONSUMER that skips WorkspaceGate for
    // secondary surfaces (see the fixme-ready note) — no second acquire fires.
    createRoot((dispose) => {
      const first = acquireWorkspaceConnection({ workspaceId: "ws_two_panes", kind: "user-hosted", request: runtimeReadyFetch })
      expect(workspaceConnection("ws_two_panes")?.refs).toBe(1)

      const second = acquireWorkspaceConnection({ workspaceId: "ws_two_panes", kind: "user-hosted", request: runtimeReadyFetch })
      expect(workspaceConnection("ws_two_panes")?.refs).toBe(2)

      second.release()
      expect(workspaceConnection("ws_two_panes")?.refs).toBe(1)
      first.release()
      dispose()
    })
  })

  test("re-acquire during the teardown debounce window cancels teardown", () => {
    createRoot((dispose) => {
      const first = acquireWorkspaceConnection({ workspaceId: "ws_swap", kind: "local" })
      first.release() // schedules debounced teardown, refs -> 0
      expect(workspaceConnection("ws_swap")?.refs).toBe(0)

      const second = acquireWorkspaceConnection({ workspaceId: "ws_swap", kind: "local" })
      // Re-acquire bumps refs back up and clears the pending teardown timer.
      expect(workspaceConnection("ws_swap")?.refs).toBe(1)
      second.release()
      dispose()
    })
  })

  test("offline classification: forbidden is terminal; others are transient", () => {
    expect(internals.classifyOffline({ message: "Workspace connection failed: 403" })).toBe("forbidden")
    expect(internals.classifyOffline({ message: "forbidden" })).toBe("forbidden")
    expect(internals.classifyOffline({ offline: true })).toBe("no-host")
    expect(internals.classifyOffline({ message: "Runtime health check failed: 502" })).toBe("unreachable")
    expect(internals.classifyOffline({ message: "network timeout" })).toBe("unreachable")
    expect(internals.classifyOffline({ message: "Workspace connection failed: 500" })).toBe("failed")
    // The relay poll's give-up throw ("Workspace runtime is still provisioning",
    // workspace-relay-connection.ts) is a client-side wait cap, not a server
    // failure — it must NOT read as "Workspace failed to start".
    expect(internals.classifyOffline({ message: "Workspace runtime is still provisioning" })).toBe(
      "still-provisioning",
    )

    expect(internals.isTerminalReason("forbidden")).toBe(true)
    expect(internals.isTerminalReason("no-host")).toBe(false)
    expect(internals.isTerminalReason("unreachable")).toBe(false)
    expect(internals.isTerminalReason("failed")).toBe(false)
    expect(internals.isTerminalReason("still-provisioning")).toBe(false)
  })

  test("workspaceOffline reads the offline reason; predicates ignore unknown ids", () => {
    createRoot((dispose) => {
      acquireWorkspaceConnection({ workspaceId: "ws_off", kind: "user-hosted", request: runtimeReadyFetch })
      // Inject a terminal offline state via the single-writer test seam.
      internals.setState("ws_off", "status", { offline: "forbidden" })
      internals.setState("ws_off", "terminal", true)

      expect(workspaceOffline("ws_off")).toBe("forbidden")
      expect(isWorkspaceReady("ws_off")).toBe(false)
      expect(isWorkspaceConnecting("ws_off")).toBe(false)

      // Unknown / undefined ids never read as ready/connecting/offline.
      expect(isWorkspaceReady(undefined)).toBe(false)
      expect(isWorkspaceReady("ws_missing")).toBe(false)
      expect(isWorkspaceConnecting(undefined)).toBe(false)
      expect(workspaceOffline(undefined)).toBeUndefined()
      dispose()
    })
  })

  test("retry is a no-op for terminal failures, redrives for transient ones", () => {
    createRoot((dispose) => {
      acquireWorkspaceConnection({ workspaceId: "ws_retry_t", kind: "user-hosted", request: runtimeReadyFetch })
      internals.setState("ws_retry_t", "status", { offline: "forbidden" })
      internals.setState("ws_retry_t", "terminal", true)
      retryWorkspaceConnection("ws_retry_t")
      // Terminal — retry must not redrive back to connecting.
      expect(workspaceOffline("ws_retry_t")).toBe("forbidden")

      acquireWorkspaceConnection({ workspaceId: "ws_retry_x", kind: "local" })
      internals.setState("ws_retry_x", "status", { offline: "unreachable" })
      internals.setState("ws_retry_x", "terminal", false)
      internals.setState("ws_retry_x", "kind", "local")
      retryWorkspaceConnection("ws_retry_x")
      // Transient + local kind redrives to ready immediately.
      expect(isWorkspaceReady("ws_retry_x")).toBe(true)
      dispose()
    })
  })

  test("reconnecting transitions: ready -> reconnecting -> ready (queries park, no teardown)", () => {
    createRoot((dispose) => {
      acquireWorkspaceConnection({ workspaceId: "ws_reco", kind: "local" })
      expect(isWorkspaceReady("ws_reco")).toBe(true)

      markWorkspaceReconnecting("ws_reco")
      expect(workspaceConnection("ws_reco")?.status).toBe("reconnecting")
      expect(connectionPlacement("ws_reco")).toEqual({ state: "reconnecting", workspaceId: "ws_reco", role: "owner" })
      expect(workspacePlacement("ws_reco")?.role).toBe("owner")
      // Reconnecting is NOT ready — workspace queries park.
      expect(isWorkspaceReady("ws_reco")).toBe(false)
      expect(isWorkspaceConnecting("ws_reco")).toBe(true)
      // Entry survives (no teardown).
      expect(workspaceConnection("ws_reco")).toBeDefined()

      markWorkspaceReconnected("ws_reco")
      expect(isWorkspaceReady("ws_reco")).toBe(true)
      expect(connectionPlacement("ws_reco")).toEqual({ state: "role-known", workspaceId: "ws_reco", role: "owner" })
      dispose()
    })
  })

  test("markWorkspaceReconnecting only fires from ready; reconnected only from reconnecting", () => {
    createRoot((dispose) => {
      acquireWorkspaceConnection({ workspaceId: "ws_guard", kind: "user-hosted", request: runtimeReadyFetch })
      // status is "connecting" — reconnecting/reconnected are guarded no-ops.
      markWorkspaceReconnecting("ws_guard")
      expect(workspaceConnection("ws_guard")?.status).toBe("connecting")
      markWorkspaceReconnected("ws_guard")
      expect(workspaceConnection("ws_guard")?.status).toBe("connecting")
      dispose()
    })
  })
})
