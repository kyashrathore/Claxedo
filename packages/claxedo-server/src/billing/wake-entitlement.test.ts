import { describe, expect, test, vi } from "vitest"
import { hostedConnectionInfo } from "../routes/workspace/hosted-connection-info"
import type { ControlPlaneServices } from "../authority/services"
import type { SignedControlPlaneAuth } from "../authority/auth"

/**
 * F3 (adversarial-review): the cloud-workspace entitlement is enforced at
 * wake/resume — the sandbox-lease acquisition choke point — not only at create.
 * A canceled subscription must not keep an existing cloud workspace wake-able.
 * The gate sits in `hostedConnectionInfo` (the hosted `/:id/connection` path
 * that drives `sandboxManager.ensure`), guarded on backing=cloud-vm/access=cloud
 * so self-host / local never see it, and composed only in hosted-app.ts.
 */

const auth = {
  mode: "signed",
  token: "user_1",
  user: { subject: "user_1", tokenIdentifier: "user_1", issuer: "https://issuer.test" },
} as unknown as SignedControlPlaneAuth

function services(ensure: ReturnType<typeof vi.fn>) {
  return {
    authority: {
      usersMe: vi.fn(async () => ({ subject: "user_1" })),
      openWorkspace: vi.fn(async () => ({
        allowed: true,
        role: "owner",
        workspace: { backing: "cloud-vm", access: "cloud", home_region: "us-east" },
      })),
      auditDeny: vi.fn(async () => ({})),
    },
    sandbox: { sandboxManager: { ensure } },
    telemetry: { capture: vi.fn() },
  } as unknown as ControlPlaneServices
}

const options = { defaultHomeRegion: "us-east" as const, relayUrl: "wss://relay.test" }

describe("F3: cloud-workspace entitlement at wake/resume", () => {
  test("free org → 402 typed denial; the sandbox is NEVER woken", async () => {
    const ensure = vi.fn()
    const requireCloudWorkspaceEntitlement = vi.fn(async () => ({
      status: 402 as const,
      body: { error: { code: "billing_entitlement_required", message: "subscription required" } },
    }))
    const result = await hostedConnectionInfo(
      services(ensure),
      { ...options, requireCloudWorkspaceEntitlement },
      auth,
      "ws_1",
    )
    expect(result).toMatchObject({ status: 402, error: { code: "billing_entitlement_required" } })
    expect(requireCloudWorkspaceEntitlement).toHaveBeenCalledTimes(1)
    expect(ensure).not.toHaveBeenCalled()
  })

  test("mirror unreadable → 503 fail-closed; the sandbox is NEVER woken", async () => {
    const ensure = vi.fn()
    const requireCloudWorkspaceEntitlement = vi.fn(async () => ({
      status: 503 as const,
      body: { error: { code: "billing_state_unavailable", message: "fail closed" } },
    }))
    const result = await hostedConnectionInfo(
      services(ensure),
      { ...options, requireCloudWorkspaceEntitlement },
      auth,
      "ws_1",
    )
    expect(result).toMatchObject({ status: 503, error: { code: "billing_state_unavailable" } })
    expect(ensure).not.toHaveBeenCalled()
  })

  test("entitled org → the sandbox wake proceeds", async () => {
    const ensure = vi.fn(async () => ({
      status: "provisioning",
      retryAfterMs: 2_000,
      epoch: 1,
      homeRegion: "us-east",
    }))
    const requireCloudWorkspaceEntitlement = vi.fn(async () => undefined)
    const result = await hostedConnectionInfo(
      services(ensure),
      { ...options, requireCloudWorkspaceEntitlement },
      auth,
      "ws_1",
    )
    expect(requireCloudWorkspaceEntitlement).toHaveBeenCalledTimes(1)
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ connection: { status: "provisioning" } })
  })

  test("no hook composed (self-host / local) → wake proceeds ungated", async () => {
    const ensure = vi.fn(async () => ({
      status: "provisioning",
      retryAfterMs: 2_000,
      epoch: 1,
      homeRegion: "us-east",
    }))
    const result = await hostedConnectionInfo(services(ensure), { ...options }, auth, "ws_1")
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ connection: { status: "provisioning" } })
  })
})
