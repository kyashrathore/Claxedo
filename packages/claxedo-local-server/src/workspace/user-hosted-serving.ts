/**
 * The desktop machine's relay connection — the SERVING half of remote access.
 *
 * Registration was never serving: a share is routable only while this machine
 * holds an outbound tunnel to the relay for it. Under machine-wide enrollment
 * the credential arrives on every heartbeat ack (ONE Host Tunnel Token whose
 * claim is exactly the assigned∩acked workspace set), travels connector child
 * → Electron main → this daemon, and this module turns it into exactly one
 * relay connection registered for that set.
 *
 * Idempotent by construction: the same relay and set reuse the live
 * connection and only refresh the token; a changed set re-registers in place;
 * a null credential (nothing routable, remote access stopped) closes it.
 *
 * The relay may only reach workspace-runtime routes on workspaces in the
 * CURRENT set — the same two-guard shape the self-host node's tunnel runner
 * uses (`claxedo-server/src/user-hosted-tunnel.ts`): membership first, then
 * route ownership, so a malicious relay cannot ask a laptop for a
 * CentralServer-owned path.
 */

import {
  hostTunnelPreOpenQueueFromEnv,
  startWorkspaceRelayHostTunnel,
  type WorkspaceRelayHostTunnel,
  type WorkspaceRelayHostTunnelEvent,
} from "@claxedo/workspace-runtime/relay"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { routeOwnership, RouteHandler } from "@claxedo/server-core/platform/governance/route-ownership"
import { FORWARDED_CLIENT_HEADERS } from "@claxedo/server-core/platform/http/peer-address"

const log = Log.create({ service: "user-hosted-serving" })

/**
 * What the tunnel must NOT carry onto the loopback replay.
 *
 * A relay-delivered request reaches this daemon as a fetch the machine makes
 * to its own `127.0.0.1` server, and the daemon's relay-shaped surface
 * requires exactly that ("Host-tunnel traffic carries a relay-minted RHT" —
 * `runtime-dispatch/shared-workspace-endpoint.ts`). Replaying the remote
 * caller's headers verbatim made that genuinely-local request look proxied
 * and the unsigned-local gate refused it: Cloudflare stamps
 * `cf-connecting-ip`/`x-forwarded-*` on everything reaching the relay, the
 * browser sends a foreign `Origin`, and `host` names the relay — each one
 * alone is a 403 (verified against the running daemon).
 *
 * Stripping them is scoped to THIS path — the tunnel's own replay — so
 * browser traffic to loopback keeps its Origin and its CSRF protection. The
 * headers describe a client that is not the one making the local request, so
 * forwarding them was never meaningful here; authorization for relay traffic
 * is the relay's verified Runtime Access Token plus this module's own
 * registration and route-ownership guards, not the socket the request
 * arrived on.
 */
const REPLAY_STRIPPED_HEADERS = [...FORWARDED_CLIENT_HEADERS, "origin", "host"] as const

/** The tunnel's local replay, with the remote caller's identity headers removed. */
export function loopbackReplayHeaders(input: Record<string, string>): Record<string, string> {
  const stripped = new Set<string>(REPLAY_STRIPPED_HEADERS)
  return Object.fromEntries(Object.entries(input).filter(([name]) => !stripped.has(name.toLowerCase())))
}

export type UserHostedServingCredential = {
  hostId: string
  relayUrl: string
  token: string
  workspaceIds: readonly string[]
}

type ActiveServing = {
  tunnel: WorkspaceRelayHostTunnel
  hostId: string
  relayUrl: string
  token: { current: string }
  registration: { current: Set<string> }
}

let active: ActiveServing | undefined

function normalized(input: string) {
  return input.trim().replace(/\/+$/, "")
}

function logTunnelEvent(context: { hostId: string; relayUrl: string }, event: WorkspaceRelayHostTunnelEvent) {
  if (event.type === "auth-failed") {
    log.error("user-hosted serving tunnel auth failed", { ...context, attempt: event.attempt, error: event.error })
    return
  }
  if (event.type === "reconnecting") {
    log.warn("user-hosted serving tunnel reconnecting", {
      ...context,
      attempt: event.attempt,
      delayMs: event.delayMs,
      reason: event.reason,
    })
    return
  }
  if (event.type === "closed") {
    log.info("user-hosted serving tunnel closed", { ...context, reason: event.reason })
  }
}

/** What the daemon currently serves, for status surfaces and tests. */
export function userHostedServingState() {
  if (!active) return { serving: false as const }
  return {
    serving: true as const,
    hostId: active.hostId,
    relayUrl: active.relayUrl,
    workspaceIds: [...active.registration.current].sort(),
  }
}

export function stopUserHostedServing() {
  const current = active
  active = undefined
  current?.tunnel.close()
}

export async function setUserHostedServing(
  credential: UserHostedServingCredential | null,
  input: { localBaseUrl: string },
) {
  if (!credential || credential.workspaceIds.length === 0) {
    stopUserHostedServing()
    return userHostedServingState()
  }
  const relayUrl = normalized(credential.relayUrl)
  const workspaceIds = [...new Set(credential.workspaceIds)].sort()

  if (active && active.hostId === credential.hostId && active.relayUrl === relayUrl) {
    active.token.current = credential.token
    if ([...active.registration.current].sort().join("\n") !== workspaceIds.join("\n")) {
      await active.tunnel.updateRegistration({ workspaceIds, token: credential.token })
      active.registration.current = new Set(workspaceIds)
    }
    return userHostedServingState()
  }

  stopUserHostedServing()
  const localBaseUrl = normalized(input.localBaseUrl)
  const token = { current: credential.token }
  const registration = { current: new Set(workspaceIds) }
  const context = { hostId: credential.hostId, relayUrl }
  const tunnel = startWorkspaceRelayHostTunnel({
    relayUrl,
    hostId: credential.hostId,
    workspaceIds,
    localBaseUrl,
    resolveLocalUrl: ({ workspaceId, path }) => {
      if (!registration.current.has(workspaceId)) return
      if (routeOwnership(new URL(path, "http://workspace.local").pathname).handler !== RouteHandler.SandboxRuntime) {
        return
      }
      return new URL(
        `/workspaces/${encodeURIComponent(workspaceId)}/${path.replace(/^\/+/, "")}`,
        `${localBaseUrl}/`,
      )
    },
    tokenProvider: async () => token.current,
    localReplayHeaders: loopbackReplayHeaders,
    onEvent: (event) => logTunnelEvent(context, event),
    pingIntervalMs: 15_000,
    reconnectIntervalMs: 1_000,
    ...hostTunnelPreOpenQueueFromEnv(),
  })
  active = { tunnel, hostId: credential.hostId, relayUrl, token, registration }
  log.info("user-hosted serving tunnel started", { ...context, workspaceIds })
  return userHostedServingState()
}
