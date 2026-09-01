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
  /** When the Host Tunnel Token dies, in epoch ms — the signer's `tokenExpiresAt`. */
  expiresAt: number
}

type ActiveServing = {
  tunnel: WorkspaceRelayHostTunnel
  hostId: string
  relayUrl: string
  token: { current: string }
  registration: { current: Set<string> }
  expiresAt: number
  lapse: ReturnType<typeof setTimeout>
  /**
   * Whether the relay connection is actually OPEN, as the tunnel reports it.
   *
   * Holding a fresh credential is not the same as being reachable, and
   * conflating them is how this surface lied twice. First it kept reporting
   * `serving: true` after the credential stopped being renewed (fixed by the
   * lease). Then it reported `serving: true` with NO socket to the relay at
   * all — verified with `lsof`: zero established connections to the relay's
   * addresses while this said it was serving, and every client was correctly
   * told the host was offline.
   *
   * The tunnel already emits `open` / `reconnecting` / `closed` /
   * `auth-failed`. Recording them means the state can answer the question
   * that actually matters — can a request reach this machine right now —
   * instead of the question it happened to know the answer to.
   */
  connected: boolean
}

let active: ActiveServing | undefined

/**
 * Serving is a LEASE, not a latch.
 *
 * Every heartbeat ack renews the credential, so a machine that is still
 * beating always replaces this before it fires. If beats stop — the connector
 * child dies, the account goes away, the network drops — the control plane
 * expires the enrollment and refuses to route, and a tunnel left open here
 * would keep this daemon reporting `serving: true` while the workspace is
 * unreachable. Observed live: the child exited silently, the lease lapsed,
 * and the desktop kept claiming "Serving 2 workspaces" while the phone was
 * correctly told the host was offline.
 *
 * Stopping on lapse makes `serving: true` mean what it says: this machine
 * holds a credential the control plane has renewed recently.
 */
function armLapse(expiresAt: number, context: { hostId: string; relayUrl: string }) {
  return setTimeout(() => {
    log.warn("user-hosted serving credential lapsed; stopping the relay tunnel", { ...context, expiresAt })
    stopUserHostedServing()
  }, Math.max(0, expiresAt - Date.now()))
}

function normalized(input: string) {
  return input.trim().replace(/\/+$/, "")
}

/** The tunnel's own account of whether the relay connection is up. */
function connectedAfter(event: WorkspaceRelayHostTunnelEvent, previous: boolean) {
  if (event.type === "open") return true
  if (event.type === "reconnecting" || event.type === "closed" || event.type === "auth-failed") return false
  return previous
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
    credentialExpiresAt: active.expiresAt,
    // `serving` is intent plus a live credential; `connected` is whether the
    // relay can actually reach this machine. A reader that needs the truthful
    // answer wants this one.
    connected: active.connected,
  }
}

export function stopUserHostedServing() {
  const current = active
  active = undefined
  if (current) clearTimeout(current.lapse)
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
    // Each ack renews the lease; without this the first credential's expiry
    // would stop a machine that is still beating perfectly well.
    clearTimeout(active.lapse)
    active.expiresAt = credential.expiresAt
    active.lapse = armLapse(credential.expiresAt, { hostId: credential.hostId, relayUrl })
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
    onEvent: (event) => {
      if (active) active.connected = connectedAfter(event, active.connected)
      logTunnelEvent(context, event)
    },
    pingIntervalMs: 15_000,
    reconnectIntervalMs: 1_000,
    ...hostTunnelPreOpenQueueFromEnv(),
  })
  active = {
    tunnel,
    hostId: credential.hostId,
    relayUrl,
    token,
    registration,
    expiresAt: credential.expiresAt,
    lapse: armLapse(credential.expiresAt, context),
    // Not connected until the tunnel says `open`.
    connected: false,
  }
  log.info("user-hosted serving tunnel started", { ...context, workspaceIds, expiresAt: credential.expiresAt })
  return userHostedServingState()
}
