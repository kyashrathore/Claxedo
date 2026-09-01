import { afterEach, describe, expect, test, vi } from "vitest"
import type { HostTunnelTokenSignerResult } from "@claxedo/server-core/platform/auth/runtime-access-token"

import { UserHostedServingRoutes } from "./user-hosted-serving-routes"
import { stopUserHostedServing, userHostedServingState } from "./user-hosted-serving"

/**
 * The PUT body's `credential` is the heartbeat ack's `hostTunnel` object
 * VERBATIM. The control plane builds it in
 * `claxedo-server/src/routes/hosted/host-enrollment.ts` as the signer result
 * spread plus `hostId`, `workspaceIds` and `relayUrl` — this type restates
 * that composition so a drift in `HostTunnelTokenSignerResult` fails HERE at
 * compile time instead of as a silent 400 in production. That silent 400 is
 * not hypothetical: the first version of this route validated a locally
 * invented shape (`token` instead of `hostTunnelToken`, no metadata fields)
 * and rejected every real ack while every unit in the chain stayed green.
 */
type AckHostTunnel = HostTunnelTokenSignerResult & {
  hostId: string
  workspaceIds: string[]
  relayUrl?: string
}

function ackCredential(): AckHostTunnel {
  return {
    hostTunnelToken: "host-tunnel-token-value",
    tokenExpiresAt: 1_788_255_486_000,
    jti: "jti-1",
    hostId: "host_machine-1",
    workspaceIds: ["11111111-1111-4111-8111-111111111111"],
    relayUrl: "https://relay.claxedo.test",
  }
}

async function put(credential: unknown) {
  return UserHostedServingRoutes().request("/", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential }),
  })
}

describe("user-hosted serving routes", () => {
  afterEach(() => {
    stopUserHostedServing()
  })

  test("accepts the heartbeat ack's hostTunnel shape verbatim and serves its set", async () => {
    const response = await put(ackCredential())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      serving: true,
      hostId: "host_machine-1",
      relayUrl: "https://relay.claxedo.test",
      workspaceIds: ["11111111-1111-4111-8111-111111111111"],
    })
    expect(userHostedServingState()).toMatchObject({ serving: true })
  })

  test("a null credential stops serving", async () => {
    await put(ackCredential())
    const response = await put(null)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ serving: false })
  })

  test("rejects the previous locally-invented field names", async () => {
    const response = await put({
      hostId: "host_machine-1",
      relayUrl: "https://relay.claxedo.test",
      token: "renamed-field",
      workspaceIds: ["11111111-1111-4111-8111-111111111111"],
    })
    expect(response.status).toBe(400)
    expect(userHostedServingState()).toEqual({ serving: false })
  })

  /**
   * The live failure this closes: the connector child exited silently, no ack
   * renewed the credential, the control plane expired the enrollment and
   * answered 409 — while the daemon went on reporting `serving: true` and the
   * desktop kept showing "Serving 2 workspaces".
   */
  test("stops serving when the credential lapses without a renewing ack", async () => {
    vi.useFakeTimers()
    try {
      await put({ ...ackCredential(), tokenExpiresAt: Date.now() + 60_000 })
      expect(userHostedServingState()).toMatchObject({ serving: true })
      vi.advanceTimersByTime(59_000)
      expect(userHostedServingState(), "still leased").toMatchObject({ serving: true })
      vi.advanceTimersByTime(2_000)
      expect(userHostedServingState()).toEqual({ serving: false })
    } finally {
      vi.useRealTimers()
    }
  })

  test("a renewing ack extends the lease rather than letting the first expiry stop it", async () => {
    vi.useFakeTimers()
    try {
      await put({ ...ackCredential(), tokenExpiresAt: Date.now() + 60_000 })
      vi.advanceTimersByTime(50_000)
      await put({ ...ackCredential(), tokenExpiresAt: Date.now() + 60_000 })
      vi.advanceTimersByTime(20_000)
      expect(userHostedServingState(), "a beating machine must not be stopped").toMatchObject({ serving: true })
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * `serving` is intent plus a live credential. It is NOT reachability, and
   * reading it as reachability is how this surface lied: verified live with
   * `lsof`, the daemon reported `serving: true` with ZERO established
   * connections to the relay, while every client was correctly told the host
   * was offline. `connected` is the tunnel's own account of the socket.
   */
  test("reports the tunnel as not connected until it opens", async () => {
    await put(ackCredential())
    expect(userHostedServingState()).toMatchObject({ serving: true, connected: false })
  })

  test("rejects a credential without a relay to dial", async () => {
    const { relayUrl: _omitted, ...withoutRelay } = ackCredential()
    const response = await put(withoutRelay)
    expect(response.status).toBe(400)
    expect(userHostedServingState()).toEqual({ serving: false })
  })
})
