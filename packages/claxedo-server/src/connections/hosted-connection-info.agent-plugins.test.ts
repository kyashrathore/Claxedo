import { describe, expect, test, vi } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServices } from "../authority/services"
import { hostedConnectionInfo } from "./hosted-connection-info"

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
      usersMe: vi.fn(async () => ({ subject: "user_1" })),
      openWorkspace: vi.fn(async () => ({
        allowed: true,
        role: "owner",
        workspace: { workspace_id: "ws_1", org_id: "org_1", backing: "cloud-vm", access: "cloud", home_region: "us-east" },
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
    }, auth, "ws_1")

    expect(order).toEqual(["ensure", "plugins", "token"])
    expect(result).toMatchObject({ connection: { runtimeAccessToken: "runtime-token" } })
  })

  test("prepares brokered credentials before ensure and provisions the exact same immutable plan", async () => {
    const order: string[] = []
    const { services, signer } = subject(order)
    const preparation = {
      secrets: [{ name: "CLAXEDO_MCP_A", value: "Bearer gateway-token", hosts: ["mcp-a.example"], header: "Authorization" }],
      state: { kind: "test-plan" },
    }
    const provisionRuntime = vi.fn(async () => { order.push("plugins") })
    const result = await hostedConnectionInfo(services, {
      defaultHomeRegion: "us-east",
      relayUrl: "wss://relay.test",
      runtimeAccessTokenSigner: signer,
      prepareRuntime: async () => { order.push("prepare"); return preparation },
      provisionRuntime,
    }, auth, "ws_1")

    expect(order).toEqual(["prepare", "ensure", "plugins", "token"])
    expect(services.sandbox.sandboxManager!.ensure).toHaveBeenCalledWith("ws_1", {
      homeRegion: "us-east",
      secrets: preparation.secrets,
    })
    expect(provisionRuntime).toHaveBeenCalledWith("ws_1", preparation)
    expect(result).toMatchObject({ connection: { runtimeAccessToken: "runtime-token" } })
  })

  test("a failed plugin apply denies handoff and never mints a runtime token", async () => {
    const order: string[] = []
    const { services, signer } = subject(order)
    const result = await hostedConnectionInfo(services, {
      defaultHomeRegion: "us-east",
      relayUrl: "wss://relay.test",
      runtimeAccessTokenSigner: signer,
      provisionRuntime: async () => { throw new Error("artifact corrupt") },
    }, auth, "ws_1")

    expect(order).toEqual(["ensure"])
    expect(signer).not.toHaveBeenCalled()
    expect(result).toMatchObject({ status: 409, error: { code: "runtime_provision_failed", message: "artifact corrupt" } })
  })
})
