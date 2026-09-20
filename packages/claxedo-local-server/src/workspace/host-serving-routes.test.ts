import { afterEach, describe, expect, test, vi } from "vitest"
import type { HostTunnelTokenSignerResult } from "@claxedo/server-core/platform/auth/runtime-access-token"

import { HostServingRoutes } from "./host-serving-routes"
import {
  stopHostServing,
  hostServingEnrollmentId,
  hostServingState,
} from "@claxedo/host-serving/serving"
import { embeddedWorkspaceRuntimeSessionAuthority } from "../deployments/local/embedded-workspace-runtime"

const state = () => hostServingState({ sessionAuthority: embeddedWorkspaceRuntimeSessionAuthority })

/**
 * The PUT body's `credential` is the heartbeat ack's `hostTunnel` object
 * VERBATIM. The control plane builds it in
 * `claxedo-server/src/routes/hosted/host-enrollment.ts` as the signer result
 * spread plus `hostId`, `enrollmentId`, `workspaceIds` and `relayUrl` — this
 * type restates that composition so a drift in `HostTunnelTokenSignerResult`
 * fails HERE at compile time. A locally invented shape would reject every
 * real ack with a 400 while every unit in the chain stayed green.
 */
type AckHostTunnel = HostTunnelTokenSignerResult & {
  hostId: string
  enrollmentId: string
  workspaceIds: string[]
  relayUrl?: string
}

function ackCredential(): AckHostTunnel {
  return {
    hostTunnelToken: "host-tunnel-token-value",
    tokenExpiresAt: 1_788_255_486_000,
    jti: "jti-1",
    hostId: "host_machine-1",
    enrollmentId: "enr_this_machine",
    workspaceIds: ["11111111-1111-4111-8111-111111111111"],
    relayUrl: "https://relay.claxedo.test",
  }
}

async function put(credential: unknown) {
  return HostServingRoutes().request("/", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential }),
  })
}

describe("host serving routes", () => {
  afterEach(() => {
    stopHostServing()
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
    expect(state()).toMatchObject({ serving: true })
  })

  test("reports this daemon's runtime composition whether or not it is serving", async () => {
    // Electron main reads this to learn what its Host Connector must DECLARE
    // on every enrollment heartbeat: the control plane mints each client's
    // event-stream scope from that declaration and infers nothing. It has to
    // be answerable BEFORE anything is served, because the connector's first
    // beat happens before the serving credential comes back from it.
    const idle = await HostServingRoutes().request("/")
    expect(await idle.json()).toEqual({ serving: false, sessionAuthority: "local" })

    await put(ackCredential())
    const serving = await HostServingRoutes().request("/")
    expect(await serving.json()).toMatchObject({ serving: true, sessionAuthority: "local" })
  })

  test("a null credential stops serving", async () => {
    await put(ackCredential())
    const response = await put(null)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ serving: false, sessionAuthority: "local" })
  })

  test("rejects a body whose field names are not the producer's", async () => {
    const response = await put({
      hostId: "host_machine-1",
      relayUrl: "https://relay.claxedo.test",
      token: "renamed-field",
      workspaceIds: ["11111111-1111-4111-8111-111111111111"],
    })
    expect(response.status).toBe(400)
    expect(state()).toEqual({ serving: false, sessionAuthority: "local" })
  })

  /**
   * When the connector child dies, no ack renews the credential and the
   * control plane expires the enrollment and answers 409; without the lease
   * this daemon would go on reporting `serving: true` to the desktop.
   */
  test("stops serving when the credential lapses without a renewing ack", async () => {
    vi.useFakeTimers()
    try {
      await put({ ...ackCredential(), tokenExpiresAt: Date.now() + 60_000 })
      expect(state()).toMatchObject({ serving: true })
      vi.advanceTimersByTime(59_000)
      expect(state(), "still leased").toMatchObject({ serving: true })
      vi.advanceTimersByTime(2_000)
      expect(state()).toEqual({ serving: false, sessionAuthority: "local" })
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
      expect(state(), "a beating machine must not be stopped").toMatchObject({ serving: true })
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * `serving` is intent plus a live credential, not reachability: a daemon can
   * hold a fresh token with no established connection to the relay while every
   * client is told the host is offline. `connected` is the tunnel's own
   * account of the socket.
   */
  test("reports the tunnel as not connected until it opens", async () => {
    await put(ackCredential())
    expect(state()).toMatchObject({ serving: true, connected: false })
  })

  // The daemon's bootstrap reads this to tell its clients which machine they
  // are talking to; a control-plane row naming this enrollment is then reached
  // over loopback instead of back around through the relay.
  test("holds the enrollment the credential names, for as long as it serves", async () => {
    expect(hostServingEnrollmentId()).toBeUndefined()

    await put(ackCredential())
    expect(hostServingEnrollmentId()).toBe("enr_this_machine")

    await put(null)
    expect(hostServingEnrollmentId()).toBeUndefined()
  })

  test("a credential naming no enrollment is refused rather than served anonymously", async () => {
    const { enrollmentId: _omitted, ...withoutEnrollment } = ackCredential()
    const response = await put(withoutEnrollment)
    expect(response.status).toBe(400)
    expect(state()).toEqual({ serving: false, sessionAuthority: "local" })
    expect(hostServingEnrollmentId()).toBeUndefined()
  })

  test("rejects a credential without a relay to dial", async () => {
    const { relayUrl: _omitted, ...withoutRelay } = ackCredential()
    const response = await put(withoutRelay)
    expect(response.status).toBe(400)
    expect(state()).toEqual({ serving: false, sessionAuthority: "local" })
  })
})
