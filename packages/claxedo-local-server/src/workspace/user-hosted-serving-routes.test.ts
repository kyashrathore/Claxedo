import { afterEach, describe, expect, test } from "vitest"
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

  test("rejects a credential without a relay to dial", async () => {
    const { relayUrl: _omitted, ...withoutRelay } = ackCredential()
    const response = await put(withoutRelay)
    expect(response.status).toBe(400)
    expect(userHostedServingState()).toEqual({ serving: false })
  })
})
