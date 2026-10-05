import { describe, expect, test, vi } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServices } from "../authority/services"
import { hostedConnectionInfo, type FirstLease } from "./hosted-connection-info"
import type { SandboxStart } from "../workspace/sandbox-start"
import { hostTunnelConnectionInfo } from "./host-tunnel-connection"

const auth = {
  mode: "signed",
  token: "token",
  user: { subject: "user_1", tokenIdentifier: "user_1", issuer: "https://issuer.test" },
} as unknown as SignedControlPlaneAuth

const LEASED: FirstLease = { admission: { capLease: async () => undefined }, usage: undefined }

function subject(order: string[]) {
  const signer = vi.fn(async () => {
    order.push("token")
    return { runtimeAccessToken: "runtime-token", tokenExpiresAt: Date.now() + 60_000, jti: "jti_1" }
  })
  const services = {
    authority: {
      usersMe: vi.fn(async () => ({
        subject: "user_1",
        // `resolveRuntimeActor` refuses to mint without a full actor identity.
        actor_id: "user_1",
        actor_kind: "human",
        actor_public_id: "user_1",
        actor_name: "Signed User",
      })),
      openWorkspace: vi.fn(async () => ({
        allowed: true,
        role: "owner",
        workspace: { workspace_id: "ws_1", org_id: "org_1", project_id: "project_1", backing: "cloud-vm", home_region: "us-east", repo_url: "https://git.acme.test/private.git" },
      })),
      recordRuntimeAccessToken: vi.fn(async () => undefined),
      auditAllow: vi.fn(async () => undefined),
      auditDeny: vi.fn(async () => undefined),
    },
    sandbox: {
      sandboxManager: {
        target: vi.fn(async () => ({ status: "ready", hostId: "host_1", epoch: 1 })),
      },
    },
    telemetry: { capture: vi.fn() },
  } as unknown as ControlPlaneServices
  const ready = { status: "ready" as const, sandboxId: "sb_1", url: "https://sandbox.test", hostId: "host_1", epoch: 1, homeRegion: "us-east" }
  const options = (sandboxStart: SandboxStart) => ({
    defaultHomeRegion: "us-east",
    relayUrl: "wss://relay.test",
    sandboxControlPlaneOrigin: "https://control.test",
    runtimeAccessTokenSigner: signer,
    sandboxStart,
  })
  return { services, signer, ready, options }
}

describe("Agent Plugins cloud readiness gate", () => {
  test("mints the user token only once the start, which applies the plugin snapshot itself, answers ready", async () => {
    const order: string[] = []
    const { services, signer, ready, options } = subject(order)
    const result = await hostedConnectionInfo(services, options(async (workspaceId) => {
      order.push(`start ${workspaceId}`)
      return ready
    }), auth, "ws_1", LEASED)

    expect(order).toEqual(["start ws_1", "token"])
    expect(result).toMatchObject({ connection: { runtimeAccessToken: "runtime-token", hostId: "host_1" } })
    expect(signer).toHaveBeenCalledTimes(1)
  })

  test("a start the runtime's preparation refused denies the wake with its reason and mints nothing", async () => {
    const { services, signer, options } = subject([])
    const result = await hostedConnectionInfo(services, options(async () => ({
      status: "failed",
      code: "runtime_prepare_failed",
      message: "gateway signing key unavailable",
    })), auth, "ws_1", LEASED)

    expect(result).toMatchObject({
      status: 409,
      error: { code: "runtime_prepare_failed", message: "gateway signing key unavailable" },
    })
    expect(signer).not.toHaveBeenCalled()
  })

  test("a start whose plugin apply failed denies handoff and never mints a runtime token", async () => {
    const { services, signer, options } = subject([])
    const result = await hostedConnectionInfo(services, options(async () => ({
      status: "failed",
      code: "runtime_provision_failed",
      message: "artifact corrupt",
    })), auth, "ws_1", LEASED)

    expect(signer).not.toHaveBeenCalled()
    expect(result).toMatchObject({ status: 409, error: { code: "runtime_provision_failed", message: "artifact corrupt" } })
  })
})

function machinePlacedSubject(order: string[]) {
  const signer = vi.fn(async () => {
    order.push("token")
    return { runtimeAccessToken: "runtime-token", tokenExpiresAt: Date.now() + 60_000, jti: "jti_1" }
  })
  const services = {
    authority: {
      // The host declares its runtime's session authority on the heartbeat;
      // the machine-placement mint asks for it before the plugin gate runs.
      activeWorkspaceHost: vi.fn(async () => ({
        active: true,
        host_id: "host_1",
        workspace_id: "ws_local",
        expires_at: Date.now() + 60_000,
        last_seen_at: Date.now(),
      })),
      usersMe: vi.fn(async () => ({
        subject: "user_1",
        // `resolveRuntimeActor` refuses to mint without a full actor identity.
        actor_id: "user_1",
        actor_kind: "human",
        actor_public_id: "user_1",
        actor_name: "Signed User",
      })),
      openWorkspace: vi.fn(async () => ({
        allowed: true,
        role: "owner",
        workspace: {
          workspace_id: "ws_local",
          org_id: "org_1",
          backing: "local-worktree",
          home_region: "us-east",
        },
      })),
      activeLocalHostLink: vi.fn(async () => ({
        active: true,
        host_id: "host_local",
        expires_at: Date.now() + 60_000,
      })),
      recordRuntimeAccessToken: vi.fn(async () => undefined),
      auditAllow: vi.fn(async () => undefined),
      auditDeny: vi.fn(async () => undefined),
    },
    sandbox: {},
    telemetry: { capture: vi.fn() },
  } as unknown as ControlPlaneServices
  return { services, signer }
}

describe("Agent Plugins machine-placement readiness gate", () => {
  test("applies the same signed snapshot before minting a local-session token", async () => {
    const order: string[] = []
    const { services, signer } = machinePlacedSubject(order)
    const preparation = { state: { kind: "test-plan" } }
    const prepareRuntime = vi.fn(async () => { order.push("prepare"); return preparation })
    const provisionRuntime = vi.fn(async () => { order.push("plugins") })
    const result = await hostTunnelConnectionInfo(services, {
      defaultHomeRegion: "us-east",
      relayUrl: "wss://relay.test",
      sandboxControlPlaneOrigin: "https://control.test",
      runtimeAccessTokenSigner: signer,
      prepareRuntime,
      provisionRuntime,
    }, auth, "ws_local")

    expect(order).toEqual(["prepare", "plugins", "token"])
    expect(prepareRuntime).toHaveBeenCalledWith({ workspaceId: "ws_local" })
    expect(provisionRuntime).toHaveBeenCalledWith({ workspaceId: "ws_local" }, preparation)
    expect(result).toMatchObject({
      connection: { backing: "local-worktree", runtimeAccessToken: "runtime-token" },
    })
  })

  test("a preparation that throws denies the local session before any plugin apply", async () => {
    const order: string[] = []
    const { services, signer } = machinePlacedSubject(order)

    const result = await hostTunnelConnectionInfo(services, {
      defaultHomeRegion: "us-east",
      relayUrl: "wss://relay.test",
      sandboxControlPlaneOrigin: "https://control.test",
      runtimeAccessTokenSigner: signer,
      prepareRuntime: async () => { throw new Error("gateway signing key unavailable") },
      provisionRuntime: async () => { order.push("plugins") },
    }, auth, "ws_local")

    expect(order).toEqual([])
    expect(signer).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      status: 409,
      error: { code: "runtime_prepare_failed", message: "gateway signing key unavailable" },
    })
  })

  test("a failed plugin apply denies the local session and never mints a runtime token", async () => {
    const order: string[] = []
    const { services, signer } = machinePlacedSubject(order)
    const result = await hostTunnelConnectionInfo(services, {
      defaultHomeRegion: "us-east",
      relayUrl: "wss://relay.test",
      sandboxControlPlaneOrigin: "https://control.test",
      runtimeAccessTokenSigner: signer,
      prepareRuntime: async () => { order.push("prepare"); return {} },
      provisionRuntime: async () => { throw new Error("artifact corrupt") },
    }, auth, "ws_local")

    expect(order).toEqual(["prepare"])
    expect(signer).not.toHaveBeenCalled()
    expect(result).toMatchObject({ status: 409, error: { code: "runtime_provision_failed", message: "artifact corrupt" } })
  })
})
