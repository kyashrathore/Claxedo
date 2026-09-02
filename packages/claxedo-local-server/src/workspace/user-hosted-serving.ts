/**
 * The desktop machine's relay connection — the SERVING half of remote access.
 *
 * Registration was never serving: a share is routable only while this machine
 * holds an outbound tunnel to the relay for it. Under machine-wide enrollment
 * the credential arrives on every heartbeat ack (ONE Host Tunnel Token whose
 * claim is exactly the assigned∩acked workspace set), travels connector child
 * → Electron main → this daemon, and this module turns it into relay
 * connections for that set.
 *
 * ONE CONNECTION PER WORKSPACE, one credential for all of them. The machine is
 * enrolled as a machine and holds a single Host Tunnel Token, but the relay's
 * rooms are per workspace — a Durable Object room is addressed by workspace id,
 * so a socket lives in exactly one room and can serve exactly one workspace.
 * The relay says so itself, before any authentication: a `/host-tunnels/<host>`
 * connect naming more than one workspace is refused with
 * `host_tunnel_single_workspace_required` (verified live against the deployed
 * relay: two ids → 400, one id → 426 "upgrade required"). A machine-wide
 * tunnel is therefore not something this side can choose; it would need the
 * relay to key rooms by host and proxy client traffic between rooms.
 *
 * The token is shared across those connections because its claim is the whole
 * set and the relay checks membership, not equality
 * (`checkHostTunnelTarget` in `workspace-relay/src/auth.ts`), so each
 * connection presents the same token and declares its own single workspace.
 *
 * Idempotent by construction: the same relay and host reuse the live
 * connections and only refresh the token; a changed set opens and closes the
 * difference in place, leaving untouched workspaces connected; a null
 * credential (nothing routable, remote access stopped) closes everything.
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
import { userHostedSurface } from "./user-hosted-surface"
import { loopbackReplayHeaders } from "@claxedo/server-core/platform/http/peer-address"

const log = Log.create({ service: "user-hosted-serving" })

export type UserHostedServingCredential = {
  hostId: string
  relayUrl: string
  token: string
  workspaceIds: readonly string[]
  /** When the Host Tunnel Token dies, in epoch ms — the signer's `tokenExpiresAt`. */
  expiresAt: number
}

type ActiveTunnel = {
  tunnel: WorkspaceRelayHostTunnel
  /**
   * Held in its own object because the tunnel emits its first event
   * SYNCHRONOUSLY from `startWorkspaceRelayHostTunnel` — `onEvent` runs before
   * the value that call produces can be bound, so the handler cannot close
   * over the record it is part of.
   */
  status: {
    /**
     * Whether this workspace's relay connection is actually OPEN, as the
     * tunnel reports it.
     *
     * Holding a fresh credential is not the same as being reachable, and
     * conflating them is how this surface lied twice. First it kept reporting
     * `serving: true` after the credential stopped being renewed (fixed by the
     * lease). Then it reported `serving: true` with NO socket to the relay at
     * all — verified with `lsof`: zero established connections to the relay's
     * addresses while this said it was serving, and every client was correctly
     * told the host was offline. (The cause of that second lie was the
     * multi-workspace connect the relay rejects outright — see the file
     * header.)
     *
     * The tunnel already emits `open` / `reconnecting` / `closed` /
     * `auth-failed`. Recording them means the state can answer the question
     * that actually matters — can a request reach this machine right now —
     * instead of the question it happened to know the answer to.
     */
    connected: boolean
  }
}

type ActiveServing = {
  hostId: string
  relayUrl: string
  localBaseUrl: string
  token: { current: string }
  /** One relay connection per served workspace, keyed by workspace id. */
  tunnels: Map<string, ActiveTunnel>
  expiresAt: number
  lapse: ReturnType<typeof setTimeout>
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

function logTunnelEvent(
  context: { hostId: string; relayUrl: string; workspaceId: string },
  event: WorkspaceRelayHostTunnelEvent,
) {
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
  const workspaceIds = [...active.tunnels.keys()].sort()
  const connectedWorkspaceIds = workspaceIds.filter((workspaceId) => active?.tunnels.get(workspaceId)?.status.connected)
  return {
    serving: true as const,
    hostId: active.hostId,
    relayUrl: active.relayUrl,
    workspaceIds,
    credentialExpiresAt: active.expiresAt,
    // `serving` is intent plus a live credential; `connected` is whether the
    // relay can actually reach this machine. A reader that needs the truthful
    // answer wants this one — and with a connection per workspace, "reachable"
    // is only honest when EVERY workspace this machine claims to serve has an
    // open socket. `connectedWorkspaceIds` says which ones do.
    connected: workspaceIds.length > 0 && connectedWorkspaceIds.length === workspaceIds.length,
    connectedWorkspaceIds,
  }
}

export function stopUserHostedServing() {
  const current = active
  active = undefined
  if (!current) return
  clearTimeout(current.lapse)
  for (const entry of current.tunnels.values()) entry.tunnel.close()
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
  const localBaseUrl = normalized(input.localBaseUrl)
  const workspaceIds = [...new Set(credential.workspaceIds)].sort()

  // A different machine identity, relay, or local server is a different
  // serving arrangement, not an edit of this one.
  if (
    active
    && (active.hostId !== credential.hostId
      || active.relayUrl !== relayUrl
      || active.localBaseUrl !== localBaseUrl)
  ) {
    stopUserHostedServing()
  }

  const context = { hostId: credential.hostId, relayUrl }
  if (!active) {
    active = {
      hostId: credential.hostId,
      relayUrl,
      localBaseUrl,
      token: { current: credential.token },
      tunnels: new Map(),
      expiresAt: credential.expiresAt,
      lapse: armLapse(credential.expiresAt, context),
    }
  }
  const serving = active

  // One token for every connection: the ack renews it for the whole set, and
  // each tunnel reads `token.current` when it dials or redials.
  serving.token.current = credential.token
  // Each ack renews the lease; without this the first credential's expiry
  // would stop a machine that is still beating perfectly well.
  clearTimeout(serving.lapse)
  serving.expiresAt = credential.expiresAt
  serving.lapse = armLapse(credential.expiresAt, context)

  // Reconcile the difference only. A workspace that was already being served
  // keeps its open socket — re-dialling every workspace on every heartbeat ack
  // would drop live sessions twenty times a minute.
  const wanted = new Set(workspaceIds)
  for (const [workspaceId, entry] of serving.tunnels) {
    if (wanted.has(workspaceId)) continue
    serving.tunnels.delete(workspaceId)
    entry.tunnel.close()
    log.info("user-hosted serving tunnel stopped for workspace", { ...context, workspaceId })
  }
  for (const workspaceId of workspaceIds) {
    if (serving.tunnels.has(workspaceId)) continue
    serving.tunnels.set(workspaceId, openWorkspaceTunnel({ serving, workspaceId, context }))
    log.info("user-hosted serving tunnel started for workspace", {
      ...context,
      workspaceId,
      expiresAt: credential.expiresAt,
    })
  }
  return userHostedServingState()
}

/** The machine's relay connection FOR ONE WORKSPACE — the relay's room grain. */
function openWorkspaceTunnel(input: {
  serving: ActiveServing
  workspaceId: string
  context: { hostId: string; relayUrl: string }
}): ActiveTunnel {
  const { serving, workspaceId, context } = input
  // Not connected until the tunnel says `open`. Built before the call, because
  // the call reaches `onEvent` before it returns.
  const status = { connected: false }
  const tunnel = startWorkspaceRelayHostTunnel({
    relayUrl: serving.relayUrl,
    hostId: serving.hostId,
    workspaceIds: [workspaceId],
    localBaseUrl: serving.localBaseUrl,
    resolveLocalUrl: ({ workspaceId: requested, path }) => {
      // This socket serves exactly the workspace it registered for. A frame
      // naming any other workspace is not this connection's to answer, even
      // when the same machine happens to serve that one too.
      if (requested !== workspaceId) return
      // What a remote caller on THIS workspace's tunnel may reach on this
      // machine, and where it lands: the daemon's own families denied
      // outright, its OpenCode-compat root family for provider auth/OAuth/
      // project metadata, everything else the workspace runtime itself
      // (`user-hosted-surface.ts` for the full design).
      const target = userHostedSurface({ localBaseUrl: serving.localBaseUrl, workspaceId, path })
      if (target.kind === "deny") return
      return target.url
    },
    tokenProvider: async () => serving.token.current,
    localReplayHeaders: loopbackReplayHeaders,
    onEvent: (event) => {
      status.connected = connectedAfter(event, status.connected)
      logTunnelEvent({ ...context, workspaceId }, event)
    },
    pingIntervalMs: 15_000,
    reconnectIntervalMs: 1_000,
    ...hostTunnelPreOpenQueueFromEnv(),
  })
  return { tunnel, status }
}
