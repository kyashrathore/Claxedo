import { afterEach, describe, expect, test, vi } from "vitest"
import { isLoopbackLocalRequest, loopbackReplayHeaders } from "@claxedo/server-core/platform/http/peer-address"

import {
  setHostServing,
  stopHostServing,
  hostServingEnrollmentId,
  hostServingState,
} from "./serving"

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
    // The real tunnel emits `connecting` synchronously, before this call
    // returns. A mock that waited would hide any handler that reaches for
    // the value being constructed before that event fires.
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
    enrollmentId: "enr_this_machine",
    relayUrl: "https://relay.claxedo.test",
    token: overrides.token ?? "host-tunnel-token",
    workspaceIds,
    expiresAt: overrides.expiresAt ?? Date.now() + 300_000,
  }
}

const composition = { localBaseUrl: "http://127.0.0.1:2593", sessionAuthority: () => "local" as const }

const serve = (workspaceIds: string[], overrides?: { token?: string; expiresAt?: number }) =>
  setHostServing(credential(workspaceIds, overrides), composition)

const state = () => hostServingState(composition)

const live = () => started.filter((entry) => !entry.closed)

/**
 * The relay's rooms are per workspace and it enforces that at the gateway,
 * before authentication: `/host-tunnels/<host>` naming more than one workspace
 * is refused with 400 `host_tunnel_single_workspace_required`; one workspace
 * reaches the handshake's 426 `websocket_upgrade_required`.
 *
 * The machine is enrolled as a machine and holds one Host Tunnel Token; only
 * the transport is per workspace. A daemon that dials once for the whole set
 * is refused on every attempt, no socket ever exists, and every client is told
 * the workspace host is offline.
 */
describe("relay connection grain", () => {
  afterEach(() => {
    stopHostServing()
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
    const first = live()[0]
    expect(first.resolveLocalUrl({ workspaceId: WS_A, path: "/api/wr/health" })?.pathname).toBe(
      `/workspaces/${WS_A}/api/wr/health`,
    )
    expect(first.resolveLocalUrl({ workspaceId: WS_B, path: "/api/wr/health" })).toBeUndefined()
  })

  /**
   * A relayed request lands on the workspace surface or nowhere
   * (`surface.ts`). The machine's own root — its provider accounts, its
   * project inventory, its host-serving and remote-access administration — is
   * not a surface a workspace grant reaches, so those paths resolve to no
   * local URL at all and the tunnel answers them itself.
   */
  test("lets the relay reach the workspace surface, and nothing of the machine's own", async () => {
    await serve([WS_A])
    const first = live()[0]
    // The runtime's identity probe, which the control plane verifies every
    // read with. The daemon's own liveness probe shares the path, so a
    // root-surface classifier calls it central; through the tunnel it is the
    // runtime's, and a host that refuses it lists no sessions.
    expect(first.resolveLocalUrl({ workspaceId: WS_A, path: "/global/health" })?.pathname).toBe(
      `/workspaces/${WS_A}/global/health`,
    )

    for (const path of [
      "/provider?harness=opencode",
      "/provider/auth",
      "/provider/anthropic/oauth/authorize",
      "/auth/anthropic",
      "/config",
      "/project",
      "/project/current",
      "/api/claxedo/health",
      "/api/claxedo/host-serving",
    ]) {
      expect(first.resolveLocalUrl({ workspaceId: WS_A, path }), path).toBeUndefined()
    }
  })

  /**
   * `surface.ts` is a DENY-list: a runtime route it does not name reaches the
   * runtime, which answers 404 for what it does not implement. An allow-list
   * built from the daemon's root-surface ownership table would refuse every
   * runtime route that table has never heard of with a 403 the runtime never
   * asked for.
   */
  test("reaches every workspace-runtime route the deny list does not name", async () => {
    await serve([WS_A])
    const first = live()[0]
    for (const path of [
      "/path",
      "/api/wr/worktrees",
      "/api/wr/checkpoint/list",
      "/api/wr/subagent-transcripts",
      "/api/wr/file/content",
      "/api/wr/find/text",
    ]) {
      expect(first.resolveLocalUrl({ workspaceId: WS_A, path })?.pathname, path).toBe(
        `/workspaces/${WS_A}${path}`,
      )
    }
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
    const first = live()[0]
    await serve([WS_A, WS_B])
    expect(live()).toHaveLength(2)
    expect(first.closed).toBe(false)

    await serve([WS_B])
    expect(first.closed, "a workspace that stopped being served loses its socket").toBe(true)
    expect(live().map((entry) => entry.workspaceIds)).toEqual([[WS_B]])
  })

  test("reports reachable only once every served workspace has an open socket", async () => {
    await serve([WS_A, WS_B])
    expect(state()).toMatchObject({ serving: true, connected: false, connectedWorkspaceIds: [] })

    live()[0].onEvent({ type: "open" })
    expect(
      state(),
      "one of two rooms reachable is not a reachable machine",
    ).toMatchObject({ connected: false, connectedWorkspaceIds: [WS_A] })

    live()[1].onEvent({ type: "open" })
    expect(state()).toMatchObject({ connected: true, connectedWorkspaceIds: [WS_A, WS_B] })

    live()[1].onEvent({ type: "reconnecting" })
    expect(state()).toMatchObject({ connected: false, connectedWorkspaceIds: [WS_A] })
  })

  /**
   * Read by the daemon's bootstrap, so a client can tell a control-plane row
   * placed on this machine from one placed elsewhere. Held on the serving
   * arrangement rather than beside it: the lease can stop serving with no
   * caller involved, and a declaration left behind by that would name this
   * machine to clients it can no longer reach.
   */
  test("the enrollment is readable while serving and gone the moment the lease lapses", async () => {
    vi.useFakeTimers()
    try {
      expect(hostServingEnrollmentId()).toBeUndefined()

      await serve([WS_A], { expiresAt: Date.now() + 60_000 })
      expect(hostServingEnrollmentId()).toBe("enr_this_machine")

      vi.advanceTimersByTime(61_000)
      expect(state()).toMatchObject({ serving: false })
      expect(hostServingEnrollmentId()).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  test("a null credential closes every connection", async () => {
    await serve([WS_A, WS_B])
    await setHostServing(null, composition)
    expect(started.every((entry) => entry.closed)).toBe(true)
    expect(state()).toEqual({ serving: false, sessionAuthority: "local" })
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
    "x-forwarded-by": "workspace-relay",
  }
}

describe("loopback replay headers", () => {
  /**
   * Asserted against the gate the daemon actually mounts, not a restatement
   * of the strip list — a list-shaped test would pass even if production
   * still 403'd.
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

  /**
   * The replay is loopback by every measure the gate above has, so this marker
   * is the only thing left on the request that says a remote caller is behind
   * it. A host that serves its own user and relayed members on one listener
   * refuses an unverifiable request on it alone; stripping it here would hand
   * that request the machine's own user's access instead.
   */
  test("keeps the relay's own marker, which is what separates a replay from the machine's own user", () => {
    expect(loopbackReplayHeaders(relayDeliveredHeaders())["x-forwarded-by"]).toBe("workspace-relay")
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
