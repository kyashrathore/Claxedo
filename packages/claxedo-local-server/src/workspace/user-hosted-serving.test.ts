import { afterEach, describe, expect, test, vi } from "vitest"
import { isLoopbackLocalRequest } from "@claxedo/server-core/platform/http/peer-address"

import { loopbackReplayHeaders, setUserHostedServing, stopUserHostedServing, userHostedServingState } from "./user-hosted-serving"

type StartedTunnel = {
  workspaceIds: readonly string[]
  onEvent: (event: { type: string }) => void
  resolveLocalUrl: (input: { workspaceId: string; path: string }) => URL | undefined
  tokenProvider: () => Promise<string>
  closed: boolean
}

const started: StartedTunnel[] = []

vi.mock("@claxedo/workspace-runtime/relay", () => ({
  hostTunnelPreOpenQueueFromEnv: () => ({}),
  startWorkspaceRelayHostTunnel: (options: Omit<StartedTunnel, "closed">) => {
    const entry: StartedTunnel = { ...options, closed: false }
    started.push(entry)
    // The real tunnel emits `connecting` SYNCHRONOUSLY, before this call
    // returns. A mock that waited would hide every handler that reaches for
    // the value being constructed — which is exactly the crash this mock
    // originally let through and the route test caught.
    options.onEvent({ type: "connecting" })
    return {
      close: () => {
        entry.closed = true
      },
      updateRegistration: async () => {},
    }
  },
}))

const WS_A = "11111111-1111-4111-8111-111111111111"
const WS_B = "22222222-2222-4222-8222-222222222222"

function credential(workspaceIds: string[], overrides: { token?: string; expiresAt?: number } = {}) {
  return {
    hostId: "host_machine-1",
    relayUrl: "https://relay.claxedo.test",
    token: overrides.token ?? "host-tunnel-token",
    workspaceIds,
    expiresAt: overrides.expiresAt ?? Date.now() + 300_000,
  }
}

const serve = (workspaceIds: string[], overrides?: { token?: string; expiresAt?: number }) =>
  setUserHostedServing(credential(workspaceIds, overrides), { localBaseUrl: "http://127.0.0.1:2593" })

const live = () => started.filter((entry) => !entry.closed)

/**
 * The relay's rooms are per workspace and it enforces that at the gateway,
 * before authentication: `/host-tunnels/<host>` naming more than one workspace
 * is refused with `host_tunnel_single_workspace_required`. Verified against the
 * deployed relay — two `workspaceId` params answered 400 with that code, one
 * answered 426 `websocket_upgrade_required`.
 *
 * The machine is still enrolled as a MACHINE and still holds ONE Host Tunnel
 * Token; only the transport is per workspace. This is the defect that made the
 * phone say "workspace host is offline": the daemon dialled once for the whole
 * set, the relay rejected every attempt, and no socket ever existed.
 */
describe("relay connection grain", () => {
  afterEach(() => {
    stopUserHostedServing()
    started.length = 0
  })

  test("dials one connection per workspace, never one naming several", async () => {
    await serve([WS_A, WS_B])
    expect(live().map((entry) => entry.workspaceIds)).toEqual([[WS_A], [WS_B]])
    for (const entry of live()) {
      expect(entry.workspaceIds, "a multi-workspace connect is refused by the relay").toHaveLength(1)
    }
  })

  test("every connection presents the one machine-wide token", async () => {
    await serve([WS_A, WS_B], { token: "token-1" })
    expect(await Promise.all(live().map((entry) => entry.tokenProvider()))).toEqual(["token-1", "token-1"])

    await serve([WS_A, WS_B], { token: "token-2" })
    expect(
      await Promise.all(live().map((entry) => entry.tokenProvider())),
      "a renewing ack refreshes the credential every connection reads",
    ).toEqual(["token-2", "token-2"])
  })

  test("a connection answers only for its own workspace", async () => {
    await serve([WS_A, WS_B])
    const first = live()[0]!
    expect(first.resolveLocalUrl({ workspaceId: WS_A, path: "/api/wr/health" })?.pathname).toBe(
      `/workspaces/${WS_A}/api/wr/health`,
    )
    expect(first.resolveLocalUrl({ workspaceId: WS_B, path: "/api/wr/health" })).toBeUndefined()
  })

  test("a renewing ack keeps live sockets instead of redialling every workspace", async () => {
    await serve([WS_A, WS_B])
    const before = live()
    await serve([WS_A, WS_B])
    expect(live(), "beats arrive ~3x a minute; redialling would drop live sessions").toEqual(before)
    expect(started).toHaveLength(2)
  })

  test("a changed set opens and closes only the difference", async () => {
    await serve([WS_A])
    const first = live()[0]!
    await serve([WS_A, WS_B])
    expect(live()).toHaveLength(2)
    expect(first.closed).toBe(false)

    await serve([WS_B])
    expect(first.closed, "a workspace that stopped being served loses its socket").toBe(true)
    expect(live().map((entry) => entry.workspaceIds)).toEqual([[WS_B]])
  })

  test("reports reachable only once every served workspace has an open socket", async () => {
    await serve([WS_A, WS_B])
    expect(userHostedServingState()).toMatchObject({ serving: true, connected: false, connectedWorkspaceIds: [] })

    live()[0]!.onEvent({ type: "open" })
    expect(
      userHostedServingState(),
      "one of two rooms reachable is not a reachable machine",
    ).toMatchObject({ connected: false, connectedWorkspaceIds: [WS_A] })

    live()[1]!.onEvent({ type: "open" })
    expect(userHostedServingState()).toMatchObject({ connected: true, connectedWorkspaceIds: [WS_A, WS_B] })

    live()[1]!.onEvent({ type: "reconnecting" })
    expect(userHostedServingState()).toMatchObject({ connected: false, connectedWorkspaceIds: [WS_A] })
  })

  test("a null credential closes every connection", async () => {
    await serve([WS_A, WS_B])
    await setUserHostedServing(null, { localBaseUrl: "http://127.0.0.1:2593" })
    expect(started.every((entry) => entry.closed)).toBe(true)
    expect(userHostedServingState()).toEqual({ serving: false })
  })
})

const LOCAL_TARGET = "http://127.0.0.1:2593/workspaces/ws_1/api/wr/health"

/** What Cloudflare and the browser add by the time the relay hands a request over. */
function relayDeliveredHeaders(): Record<string, string> {
  return {
    authorization: "Bearer runtime-access-token",
    "content-type": "application/json",
    "cf-connecting-ip": "203.0.113.7",
    "x-forwarded-for": "203.0.113.7",
    "x-forwarded-proto": "https",
    origin: "https://app.claxedo.test",
  }
}

describe("loopback replay headers", () => {
  /**
   * Asserted against the REAL gate the daemon mounts, not against a restatement
   * of the strip list — a list-shaped test would have passed while production
   * 403'd, which is exactly how this shipped.
   */
  test("turns a relay-delivered request into one the unsigned-local gate accepts", () => {
    const verbatim = new Request(LOCAL_TARGET, { headers: relayDeliveredHeaders() })
    expect(isLoopbackLocalRequest(verbatim)).toBe(false)

    const replay = new Request(LOCAL_TARGET, { headers: loopbackReplayHeaders(relayDeliveredHeaders()) })
    expect(isLoopbackLocalRequest(replay)).toBe(true)
  })

  test("keeps the credential and payload headers the workspace endpoint needs", () => {
    const sanitized = loopbackReplayHeaders(relayDeliveredHeaders())
    expect(sanitized["authorization"]).toBe("Bearer runtime-access-token")
    expect(sanitized["content-type"]).toBe("application/json")
  })

  test("strips regardless of header case, since the relay preserves the caller's casing", () => {
    const sanitized = loopbackReplayHeaders({ "CF-Connecting-IP": "203.0.113.7", Origin: "https://app.claxedo.test" })
    expect(Object.keys(sanitized)).toEqual([])
  })

  test("each forwarded signal alone is enough to be refused, so each is stripped", () => {
    for (const [name, value] of [
      ["cf-connecting-ip", "203.0.113.7"],
      ["x-forwarded-for", "203.0.113.7"],
      ["x-forwarded-proto", "https"],
      ["origin", "https://app.claxedo.test"],
    ] as const) {
      const one = { [name]: value }
      expect(isLoopbackLocalRequest(new Request(LOCAL_TARGET, { headers: one })), name).toBe(false)
      expect(
        isLoopbackLocalRequest(new Request(LOCAL_TARGET, { headers: loopbackReplayHeaders(one) })),
        name,
      ).toBe(true)
    }
  })

  test("a request with nothing to strip is unchanged", () => {
    expect(loopbackReplayHeaders({ authorization: "Bearer t" })).toEqual({ authorization: "Bearer t" })
  })
})
