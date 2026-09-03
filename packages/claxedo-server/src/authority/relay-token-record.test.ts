import { describe, expect, test, vi } from "vitest"

import { recordRelayRuntimeToken } from "./relay-token-record"

const signed = {
  mode: "signed" as const,
  token: "user_1",
  user: { subject: "user_1", tokenIdentifier: "issuer|user_1", issuer: "issuer" },
}

const minted = {
  workspaceId: "ws_1",
  hostId: "host_1",
  orgId: "org_1",
  actorId: "actor_user_1",
  actorKind: "human" as const,
  role: "owner" as const,
  ttlMs: 60_000,
  token: "t",
  expiresAt: 1_000,
  jti: "jti_1",
}

function authority() {
  return {
    recordRuntimeAccessToken: vi.fn(async () => ({})),
    recordRuntimeAccessTokenForService: vi.fn(async () => ({})),
  }
}

describe("recordRelayRuntimeToken", () => {
  /**
   * THE bug: both hosted compositions sent every mint down the service path,
   * which refuses any actor but the control plane's own. A user's token
   * minted through the provider was denied on the live worker — the control
   * plane could not read sessions off a user-hosted machine on the user's
   * behalf, and the web app listed none.
   */
  test("records a user-principal token under the signed caller, never the service path", async () => {
    const auth = authority()
    await recordRelayRuntimeToken(auth, { ...minted, principalKind: "user", auth: signed })

    expect(auth.recordRuntimeAccessToken).toHaveBeenCalledWith(signed, {
      jti: "jti_1", workspaceId: "ws_1", hostId: "host_1", actorId: "actor_user_1",
      actorKind: "human", role: "owner", expiresAt: 1_000,
    })
    expect(auth.recordRuntimeAccessTokenForService).not.toHaveBeenCalled()
  })

  test("records a service token through the service path", async () => {
    const auth = authority()
    await recordRelayRuntimeToken(auth, { ...minted, principalKind: "service", actorKind: "agent" })

    expect(auth.recordRuntimeAccessTokenForService).toHaveBeenCalledWith(expect.objectContaining({
      principalKind: "service", jti: "jti_1",
    }))
    expect(auth.recordRuntimeAccessToken).not.toHaveBeenCalled()
  })

  /** A user mint with nobody to record it under is a bug at the call site, not a service token. */
  test("refuses a user-principal mint that carries no caller", async () => {
    await expect(recordRelayRuntimeToken(authority(), { ...minted, principalKind: "user" }))
      .rejects.toThrow("must be minted for a signed caller")
  })
})
