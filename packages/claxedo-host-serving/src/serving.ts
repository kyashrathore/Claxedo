/**
 * This machine's relay connection — the SERVING half of remote access.
 *
 * A workspace is routable only while this machine holds an outbound tunnel to
 * the relay for it. The credential arrives on every heartbeat ack (ONE Host
 * Tunnel Token whose claim is exactly the assigned∩acked workspace set) and
 * reaches the process that owns the workspace runtimes — on the desktop it
 * travels connector child → Electron main → the local-server daemon's
 * `/api/claxedo/host-serving` route; a `claxedo connect` host holds it
 * in-process — and this module turns it into relay connections for that set.
 *
 * ONE CONNECTION PER WORKSPACE, one credential for all of them. The machine is
 * enrolled as a machine and holds a single Host Tunnel Token, but the relay's
 * rooms are per workspace — a Durable Object room is addressed by workspace id,
 * so a socket lives in exactly one room and can serve exactly one workspace.
 * The relay says so itself, before any authentication: a `/host-tunnels/<host>`
 * connect naming more than one workspace is refused with
 * `host_tunnel_single_workspace_required` (400; one id reaches the 426
 * "upgrade required" of the WebSocket handshake). A machine-wide tunnel is
 * therefore not something this side can choose; it would need the relay to
 * key rooms by host and proxy client traffic between rooms.
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
 * CURRENT set: membership is checked first, then route ownership, so a relay
 * that has been taken over cannot ask a laptop for a control-plane-owned path.
 */

import {
  hostTunnelPreOpenQueueFromEnv,
  startWorkspaceRelayHostTunnel,
  type WorkspaceRelayHostTunnel,
  type WorkspaceRelayHostTunnelEvent,
} from "@claxedo/workspace-runtime/relay"
import type { SessionAccessPolicy } from "@claxedo/workspace-runtime"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { hostServingSurface } from "./surface"
import { loopbackReplayHeaders } from "@claxedo/server-core/platform/http/peer-address"

const log = Log.create({ service: "host-serving" })

export type HostServingCredential = {
  hostId: string
  /**
   * The enrollment this credential was minted for, as the control plane names
   * it on the ack beside the token whose claim already asserts it.
   */
  enrollmentId: string
  relayUrl: string
  token: string
  workspaceIds: readonly string[]
  /** When the Host Tunnel Token dies, in epoch ms — the signer's `tokenExpiresAt`. */
  expiresAt: number
}

/**
 * How the runtimes behind the served origin composed their session access —
 * the `sessionAuthority` marker of the policy they were mounted with.
 *
 * Read through a function on every call rather than captured once: the
 * daemon derives it from a policy that is configured after this module is
 * imported, and a host that serves both kinds would otherwise declare the
 * composition it had at first call forever.
 */
export type HostServingComposition = {
  localBaseUrl: string
  sessionAuthority: () => SessionAccessPolicy["sessionAuthority"]
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
     * Whether this workspace's relay connection is OPEN, as the tunnel reports
     * it through `open` / `reconnecting` / `closed` / `auth-failed`.
     *
     * A fresh credential is not reachability: with no socket to the relay,
     * every client is told the host is offline while this process still holds
     * a live token, so a status surface that answers from the credential alone
     * says `serving: true` for a machine nothing can reach.
     */
    connected: boolean
  }
}

type ActiveServing = {
  hostId: string
  enrollmentId: string
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
 * child dies, the network drops — the control plane expires the enrollment and
 * refuses to route, and a tunnel left open here would keep this process
 * reporting `serving: true` while the workspace is unreachable. Stopping on
 * lapse makes `serving: true` mean what it says: this machine holds a
 * credential the control plane has renewed recently.
 */
function armLapse(expiresAt: number, context: { hostId: string; relayUrl: string }) {
  return setTimeout(() => {
    log.warn("host serving credential lapsed; stopping the relay tunnel", { ...context, expiresAt })
    stopHostServing()
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
    log.error("host serving tunnel auth failed", { ...context, attempt: event.attempt, error: event.error })
    return
  }
  if (event.type === "reconnecting") {
    log.warn("host serving tunnel reconnecting", {
      ...context,
      attempt: event.attempt,
      delayMs: event.delayMs,
      reason: event.reason,
    })
    return
  }
  if (event.type === "closed") {
    log.info("host serving tunnel closed", { ...context, reason: event.reason })
  }
}

/**
 * What this process currently serves, for status surfaces and tests.
 *
 * `sessionAuthority` is reported whether or not anything is being served, and
 * it is the reason Electron main reads the daemon's route at all: the machine
 * has to DECLARE its runtime composition on every enrollment heartbeat, the
 * control plane mints the client's event-stream scope from that declaration
 * and refuses to infer one, and the process that composed the runtimes is the
 * only one that knows the answer — which is why it is passed in here rather
 * than looked up.
 */
export function hostServingState(input: Pick<HostServingComposition, "sessionAuthority">) {
  const sessionAuthority = input.sessionAuthority()
  if (!active) return { serving: false as const, sessionAuthority }
  const workspaceIds = [...active.tunnels.keys()].sort()
  const connectedWorkspaceIds = workspaceIds.filter((workspaceId) => active?.tunnels.get(workspaceId)?.status.connected)
  return {
    serving: true as const,
    sessionAuthority,
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

/**
 * The machine identity and relay this process is serving under, or nothing.
 *
 * Narrower than {@link hostServingState} on purpose: a caller that has
 * to VERIFY a relay-minted token wants only the two facts the token is bound
 * to — the host it was issued for and the relay that signs — and must not be
 * handed a status surface it would then have to ignore most of.
 */
export function hostServingIdentity() {
  return active ? { hostId: active.hostId, relayUrl: active.relayUrl } : undefined
}

/**
 * The enrollment this process is serving under, or nothing.
 *
 * A client of this machine compares it against the host a control-plane
 * workspace row names, which is the only thing on the wire that ties such a
 * row to the server the client is already talking to. Read off the live
 * serving arrangement rather than held separately, so it goes away with every
 * way serving ends — a withdrawal, a stop, and the lease lapse that stops it
 * with nothing pushed to say so.
 */
export function hostServingEnrollmentId() {
  return active?.enrollmentId
}

export function stopHostServing() {
  const current = active
  active = undefined
  if (!current) return
  clearTimeout(current.lapse)
  for (const entry of current.tunnels.values()) entry.tunnel.close()
}

export async function setHostServing(
  credential: HostServingCredential | null,
  input: HostServingComposition,
) {
  if (!credential || credential.workspaceIds.length === 0) {
    stopHostServing()
    return hostServingState(input)
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
    stopHostServing()
  }

  const context = { hostId: credential.hostId, relayUrl }
  if (!active) {
    active = {
      hostId: credential.hostId,
      enrollmentId: credential.enrollmentId,
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
  serving.enrollmentId = credential.enrollmentId
  // Each ack renews the lease; without this the first credential's expiry
  // would stop a machine that is still beating perfectly well.
  clearTimeout(serving.lapse)
  serving.expiresAt = credential.expiresAt
  serving.lapse = armLapse(credential.expiresAt, context)

  // Reconcile the difference only. A workspace that was already being served
  // keeps its open socket — re-dialling every workspace on every heartbeat ack
  // would drop live sessions every 20 s.
  const wanted = new Set(workspaceIds)
  for (const [workspaceId, entry] of serving.tunnels) {
    if (wanted.has(workspaceId)) continue
    serving.tunnels.delete(workspaceId)
    entry.tunnel.close()
    log.info("host serving tunnel stopped for workspace", { ...context, workspaceId })
  }
  for (const workspaceId of workspaceIds) {
    if (serving.tunnels.has(workspaceId)) continue
    serving.tunnels.set(workspaceId, openWorkspaceTunnel({ serving, workspaceId, context }))
    log.info("host serving tunnel started for workspace", {
      ...context,
      workspaceId,
      expiresAt: credential.expiresAt,
    })
  }
  return hostServingState(input)
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
      if (requested !== workspaceId) return undefined
      // What a remote caller on THIS workspace's tunnel may reach on this
      // machine, and where it lands: the local server's own families denied
      // outright, its OpenCode-compat root family for provider auth/OAuth/
      // project metadata, everything else the workspace runtime itself
      // (`surface.ts` for the full design).
      const target = hostServingSurface({ localBaseUrl: serving.localBaseUrl, workspaceId, path })
      if (target.kind === "deny") return undefined
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
