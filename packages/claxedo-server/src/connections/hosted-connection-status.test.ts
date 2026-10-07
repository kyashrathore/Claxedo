import { describe, expect, test, vi } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServices } from "../authority/services"
import { hostedConnectionStatus } from "./hosted-connection-info"

const auth = {
  mode: "signed",
  token: "token",
  user: { subject: "user_1", tokenIdentifier: "user_1", issuer: "https://issuer.test" },
} as unknown as SignedControlPlaneAuth

const READY = { status: "ready" as const, hostId: "host_1", epoch: 1, url: "https://sandbox.test", sandboxId: "sb_1", homeRegion: "us-east" }

function subject() {
  const services = {
    authority: {
      usersMe: vi.fn(async () => ({ subject: "user_1", actor_id: "user_1", actor_kind: "human", actor_public_id: "user_1", actor_name: "Signed User" })),
      openWorkspace: vi.fn(async () => ({
        allowed: true,
        role: "owner",
        workspace: { workspace_id: "ws_1", org_id: "org_1", project_id: "project_1", backing: "cloud-vm", home_region: "us-east" },
      })),
      recordRuntimeAccessToken: vi.fn(async () => undefined),
      auditAllow: vi.fn(async () => undefined),
    },
    sandbox: { sandboxManager: { target: vi.fn(async () => READY) } },
    telemetry: { capture: vi.fn() },
  } as unknown as ControlPlaneServices
  const runtimeProvisioned = vi.fn(async () => true)
  const options = (inFlight: () => Promise<{ status: "provisioning"; retryAfterMs: number; epoch: number; homeRegion: string; bootMode?: "resume" } | undefined>) => ({
    defaultHomeRegion: "us-east",
    relayUrl: "wss://relay.test",
    runtimeAccessTokenSigner: async () => ({ runtimeAccessToken: "runtime-token", tokenExpiresAt: Date.now() + 60_000, jti: "jti_1" }),
    runtimeProvisioned,
    sandboxInFlight: inFlight,
  })
  return { services, options, runtimeProvisioned }
}

describe("a connection read while a sandbox start is in flight", () => {
  test("reports the run, with its boot, instead of asking the runtime the lease still names", async () => {
    const { services, options, runtimeProvisioned } = subject()
    const result = await hostedConnectionStatus(services, options(async () => ({ status: "provisioning", retryAfterMs: 2_000, epoch: 1, homeRegion: "us-east", bootMode: "resume" })), auth, "ws_1")
    expect(result).toEqual({ connection: { status: "provisioning", workspaceId: "ws_1", homeRegion: "us-east", retryAfterMs: 2_000, bootMode: "resume" } })
    expect(runtimeProvisioned).not.toHaveBeenCalled()
  })

  test("mints off the ready, provisioned runtime once no run is in flight", async () => {
    const { services, options, runtimeProvisioned } = subject()
    const result = await hostedConnectionStatus(services, options(async () => undefined), auth, "ws_1")
    expect(result).toMatchObject({ connection: { runtimeAccessToken: "runtime-token", hostId: "host_1" } })
    expect(runtimeProvisioned).toHaveBeenCalledTimes(1)
  })
})
