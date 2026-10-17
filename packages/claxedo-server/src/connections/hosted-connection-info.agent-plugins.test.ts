import { sandboxProviderRateLimitedError } from "@claxedo/sandbox-manager"
import { describe, expect, test, vi } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServices } from "../authority/services"
import { hostedConnectionInfo } from "./hosted-connection-info"
import type { FirstLease } from "../workspace/cloud-workspace-start"
import type { SandboxStart } from "../workspace/sandbox-start"

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

  test("a start waiting out a provider failure's retry window says the failure, with the window; a lease that ended under the start says nothing of it", async () => {
    const { services, signer, options } = subject([])
    const retrying = await hostedConnectionInfo(services, options(async () => ({
      status: "unavailable", retryAfterMs: 15_000, epoch: 2, homeRegion: "us-east", error: "Boat bx_1 runtime image preparation failed (exit 1): no space left on device\n    at run (boat.ts:1:1)",
    })), auth, "ws_1", LEASED)
    expect(retrying).toEqual({ status: 409, error: { code: "cloud_runtime_unavailable", message: "Boat bx_1 runtime image preparation failed (exit 1): no space left on device", retryAfterMs: 15_000, failure: "Boat bx_1 runtime image preparation failed (exit 1): no space left on device" } })

    const ended = await hostedConnectionInfo(services, options(async () => ({ status: "unavailable", epoch: 2, homeRegion: "us-east", error: "runtime_lease_changed" })), auth, "ws_1", LEASED)
    expect(ended).toEqual({ status: 409, error: { code: "cloud_runtime_unavailable", message: "Cloud runtime is unavailable", retryAfterMs: undefined } })

    const reason = "Boat's daily start limit (200) is used up; try again later."
    const dayLimited = await hostedConnectionInfo(services, options(async () => ({
      status: "unavailable", exhausted: true, epoch: 2, homeRegion: "us-east", error: sandboxProviderRateLimitedError("boat", { window: "day", limit: 200 }),
    })), auth, "ws_1", LEASED)
    expect(dayLimited).toEqual({ status: 409, error: { code: "cloud_runtime_unavailable", message: reason, retryAfterMs: undefined, failure: reason } })

    const joined = await hostedConnectionInfo(services, options(async () => ({ status: "provisioning", retryAfterMs: 2_000, epoch: 2, homeRegion: "us-east", joined: true, failure: "provider hiccup" })), auth, "ws_1", LEASED)
    expect(joined).toEqual({ connection: { status: "provisioning", workspaceId: "ws_1", homeRegion: "us-east", retryAfterMs: 2_000, failure: "provider hiccup" } })
    expect(signer).not.toHaveBeenCalled()
  })
})
