import { describe, expect, test, vi } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServices } from "../authority/services"
import { hostedConnectionInfo } from "./hosted-connection-info"
import { userHostedConnectionInfo } from "./user-hosted-connection"

const auth = {
  mode: "signed",
  token: "token",
  user: { subject: "user_1", tokenIdentifier: "user_1", issuer: "https://issuer.test" },
} as unknown as SignedControlPlaneAuth

function subject(order: string[]) {
  const signer = vi.fn(async () => {
    order.push("token")
    return { runtimeAccessToken: "runtime-token", tokenExpiresAt: Date.now() + 60_000, jti: "jti_1" }
  })
  const services = {
    authority: {
      // The host declares its runtime's session authority on the heartbeat;
      // the user-hosted mint asks for it before the plugin gate runs.
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
        workspace: { workspace_id: "ws_1", org_id: "org_1", backing: "cloud-vm", access: "cloud", home_region: "us-east", repo_url: "https://git.acme.test/private.git" },
      })),
      recordRuntimeAccessToken: vi.fn(async () => undefined),
      auditAllow: vi.fn(async () => undefined),
      auditDeny: vi.fn(async () => undefined),
    },
    sandbox: {
      sandboxManager: {
        ensure: vi.fn(async () => {
          order.push("ensure")
          return { status: "ready", hostId: "host_1", epoch: 1, homeRegion: "us-east" }
        }),
      },
    },
    telemetry: { capture: vi.fn() },
  } as unknown as ControlPlaneServices
  return { services, signer }
}

describe("Agent Plugins cloud readiness gate", () => {
  test("applies the canonical plugin snapshot after VM health and before user token minting", async () => {
    const order: string[] = []
    const { services, signer } = subject(order)
    const result = await hostedConnectionInfo(services, {
      defaultHomeRegion: "us-east",
      relayUrl: "wss://relay.test",
      runtimeAccessTokenSigner: signer,
      provisionRuntime: async () => { order.push("plugins") },
      sandboxEgressExtraHosts: ["registry.acme.test"],
    }, auth, "ws_1", "https://control.test")

    expect(order).toEqual(["ensure", "plugins", "token"])
    expect(result).toMatchObject({ connection: { runtimeAccessToken: "runtime-token" } })
    expect(services.sandbox.sandboxManager!.ensure).toHaveBeenCalledWith("ws_1", expect.objectContaining({
      net: expect.objectContaining({ mode: "restricted", hosts: expect.arrayContaining([
        "relay.test", "control.test", "git.acme.test", "registry.acme.test", "api.anthropic.com",
      ]) }),
    }))
  })

  test("prepares brokered credentials before ensure and provisions the exact same immutable plan", async () => {
    const order: string[] = []
    const { services, signer } = subject(order)
    const preparation = {
      secrets: [{ name: "CLAXEDO_MCP_A", value: "Bearer gateway-token", hosts: ["mcp-a.example"], header: "Authorization" }],
      state: { kind: "test-plan" },
    }
    const prepareRuntime = vi.fn(async () => { order.push("prepare"); return preparation })
    const provisionRuntime = vi.fn(async () => { order.push("plugins") })
    const result = await hostedConnectionInfo(services, {
      defaultHomeRegion: "us-east",
      relayUrl: "wss://relay.test",
      runtimeAccessTokenSigner: signer,
      prepareRuntime,
      provisionRuntime,
    }, auth, "ws_1", "https://control.test")

    expect(order).toEqual(["prepare", "ensure", "plugins", "token"])
    expect(services.sandbox.sandboxManager!.ensure).toHaveBeenCalledWith("ws_1", {
      homeRegion: "us-east",
      net: expect.objectContaining({ mode: "restricted", hosts: expect.arrayContaining(["relay.test", "control.test"]) }),
      secrets: preparation.secrets,
    })
    expect(prepareRuntime).toHaveBeenCalledWith({ workspaceId: "ws_1", userId: "user_1" })
    expect(provisionRuntime).toHaveBeenCalledWith({ workspaceId: "ws_1", userId: "user_1" }, preparation)
    expect(result).toMatchObject({ connection: { runtimeAccessToken: "runtime-token" } })
  })

  test("forwards explicit withdrawal to ensure after credentials disappear", async () => {
    const { services, signer } = subject([])
    const options = {
      relayUrl: "wss://relay.test",
      runtimeAccessTokenSigner: signer,
      prepareRuntime: async () => ({ secrets: [] }),
    }
    const result = await hostedConnectionInfo(services, options, auth, "ws_1", "https://control.test")
    expect(result).toMatchObject({ connection: { runtimeAccessToken: "runtime-token" } })
    expect(services.sandbox.sandboxManager!.ensure).toHaveBeenCalledWith("ws_1", expect.objectContaining({ secrets: [] }))
  })

  test("a failed plugin apply denies handoff and never mints a runtime token", async () => {
    const order: string[] = []
    const { services, signer } = subject(order)
    const result = await hostedConnectionInfo(services, {
      defaultHomeRegion: "us-east",
      relayUrl: "wss://relay.test",
      runtimeAccessTokenSigner: signer,
      provisionRuntime: async () => { throw new Error("artifact corrupt") },
    }, auth, "ws_1", "https://control.test")

    expect(order).toEqual(["ensure"])
    expect(signer).not.toHaveBeenCalled()
    expect(result).toMatchObject({ status: 409, error: { code: "runtime_provision_failed", message: "artifact corrupt" } })
  })
})

function userHostedSubject(order: string[]) {
  const signer = vi.fn(async () => {
    order.push("token")
    return { runtimeAccessToken: "runtime-token", tokenExpiresAt: Date.now() + 60_000, jti: "jti_1" }
  })
  const services = {
    authority: {
      // The host declares its runtime's session authority on the heartbeat;
      // the user-hosted mint asks for it before the plugin gate runs.
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
          access: "user-hosted",
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

describe("Agent Plugins user-hosted readiness gate", () => {
  test("applies the same signed snapshot before minting a local-session token", async () => {
    const order: string[] = []
    const { services, signer } = userHostedSubject(order)
    const preparation = { state: { kind: "test-plan" } }
    const prepareRuntime = vi.fn(async () => { order.push("prepare"); return preparation })
    const provisionRuntime = vi.fn(async () => { order.push("plugins") })
    const result = await userHostedConnectionInfo(services, {
      defaultHomeRegion: "us-east",
      relayUrl: "wss://relay.test",
      runtimeAccessTokenSigner: signer,
      prepareRuntime,
      provisionRuntime,
    }, auth, "ws_local")

    expect(order).toEqual(["prepare", "plugins", "token"])
    expect(prepareRuntime).toHaveBeenCalledWith({ workspaceId: "ws_local", userId: "user_1" })
    expect(provisionRuntime).toHaveBeenCalledWith({ workspaceId: "ws_local", userId: "user_1" }, preparation)
    expect(result).toMatchObject({
      connection: { access: "user-hosted", backing: "local-worktree", runtimeAccessToken: "runtime-token" },
    })
  })

  test("a failed plugin apply denies the local session and never mints a runtime token", async () => {
    const order: string[] = []
    const { services, signer } = userHostedSubject(order)
    const result = await userHostedConnectionInfo(services, {
      defaultHomeRegion: "us-east",
      relayUrl: "wss://relay.test",
      runtimeAccessTokenSigner: signer,
      prepareRuntime: async () => { order.push("prepare"); return {} },
      provisionRuntime: async () => { throw new Error("artifact corrupt") },
    }, auth, "ws_local")

    expect(order).toEqual(["prepare"])
    expect(signer).not.toHaveBeenCalled()
    expect(result).toMatchObject({ status: 409, error: { code: "runtime_provision_failed", message: "artifact corrupt" } })
  })
})
