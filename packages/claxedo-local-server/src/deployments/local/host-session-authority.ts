/**
 * How the desktop daemon admits a RELAYED caller to the workspaces it serves.
 *
 * The daemon is one process with two kinds of caller. Its own user reaches it
 * over loopback and owns every session on the machine; an org member reaching
 * it through the relay owns only what the control plane says they do. One
 * policy has to answer both without handing the second the first's sessions.
 *
 * So the policy composed here is the private-session one a `claxedo connect`
 * host already mounts — the same `remoteWorkspaceSessionAccessPolicy`, asking
 * the same control-plane authority over HTTP — with `requireActor` off,
 * because this host HAS a local owner: a request with no verified actor is
 * that owner, not an unidentified caller. What keeps that safe is the ingress
 * (`runtime-dispatch/ingress-provenance.ts`), which rejects a relayed request
 * it cannot verify rather than letting it through unstamped.
 *
 * Both addresses arrive after composition. The control plane hands a machine
 * its relay key set and its authority endpoint on a heartbeat ack, and the
 * daemon's runtimes exist before the first beat — so they are read per call
 * and the relayed arm fails closed (`session_authority_unavailable`) until
 * they land. The loopback arm never asks.
 */

import {
  remoteWorkspaceSessionAccessPolicy,
  type AdoptRefusedSession,
  type SessionAccessDecision,
} from "@claxedo/workspace-runtime"
import { createRelayHostTokenVerifier } from "@claxedo/workspace-runtime/relay"
import { hostServingIdentity } from "@claxedo/host-serving/serving"
import type { RuntimeProxyOptions } from "../../workspace/runtime-dispatch/internals"
import { embeddedWorkspaceRuntimeHoldsSession } from "./embedded-workspace-runtime"

export type LocalHostEndpoints = {
  /** The relay's published key set; Relay Host Tokens are verified against it by `kid`. */
  relayJwksUrl?: string
  /** The control plane's session authority, consulted for every private-session decision. */
  sessionAuthorityUrl?: string
}

let endpoints: LocalHostEndpoints = {}

export function setLocalHostEndpoints(next: LocalHostEndpoints | undefined) {
  endpoints = next ?? {}
}

/**
 * The relay publishes its host-token keys at `/.well-known/jwks.json` under
 * the same origin it routes on, and that is the address the control plane
 * hands a host unless its deployment overrides it — so a machine that has been
 * told where to dial has been told where to verify.
 */
function relayKeySetUrl() {
  const declared = endpoints.relayJwksUrl?.trim()
  if (declared) return declared
  const serving = hostServingIdentity()
  return serving ? `${serving.relayUrl.replace(/\/+$/, "")}/.well-known/jwks.json` : undefined
}

const verifyRelayHostToken = createRelayHostTokenVerifier(relayKeySetUrl)

function relayBearer(header: string | null) {
  const match = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? "")
  return match?.[1]?.trim() || undefined
}

/**
 * The verified actor behind a relay-forwarded request, or nothing.
 *
 * Nothing for every other caller: a loopback browser on a signed desktop
 * presents a control-plane bearer, which is not issued by the relay and does
 * not validate against its key set, so it stays the machine's own user rather
 * than being promoted to a relayed member of itself.
 *
 * A token whose display identity is incomplete is unverified here rather than
 * stamped: the stamp exists to attribute authorship, and a caller it cannot
 * name is one the ingress should refuse.
 */
export const localHostRelayActor: NonNullable<RuntimeProxyOptions["resolveRelayActor"]> = async (
  request,
  workspaceId,
) => {
  const serving = hostServingIdentity()
  if (!serving) return undefined
  const token = relayBearer(request.headers.get("authorization"))
  if (!token) return undefined
  const claims = await verifyRelayHostToken({ token, workspaceId, hostId: serving.hostId })
  if (!claims?.actor_public_id || !claims.actor_name) return undefined
  return {
    actorId: claims.actor_id,
    actorKind: claims.actor_kind,
    actorPublicId: claims.actor_public_id,
    actorName: claims.actor_name,
    ...(claims.actor_avatar_url ? { actorAvatarUrl: claims.actor_avatar_url } : {}),
    orgId: claims.org_id,
    role: claims.role,
  }
}

/**
 * The adoption attempt made for each session, by workspace and session id.
 *
 * It holds the ATTEMPT, never a verdict: whoever is admitted afterwards is
 * admitted by an authorization the control plane made about them. An attempt
 * in flight is the same entry, so two concurrent first reads make one call
 * between them; a refused one is kept so the next read does not ask again,
 * while one the authority could not answer is dropped so a later read can.
 */
const adoptions = new Map<string, Promise<SessionAccessDecision>>()

/**
 * Sessions on this machine predate the moment its owner turned remote access
 * on, so the control plane has no row for them and refuses the owner's own
 * first relayed read of one. Claiming it here, on that refusal, is what makes
 * them reachable without registering anything the owner never opened remotely.
 *
 * Only for a token the relay says holds the workspace, and only for a session
 * a runtime in this process actually holds: the authority names the creator
 * itself and refuses anyone but the machine's owner, but it cannot see whether
 * the id exists here, and an id that does not would become a row for a
 * transcript nobody can read.
 */
const adoptRefusedSession: AdoptRefusedSession = async (input, refusal) => {
  if (input.authority.role !== "owner") return refusal.denial
  const workspaceId = input.authority.workspaceId
  if (!embeddedWorkspaceRuntimeHoldsSession(workspaceId, input.sessionId)) return refusal.denial
  const key = `${workspaceId}/${input.sessionId}`
  const attempt = adoptions.get(key) ?? refusal.adopt().then((outcome) => {
    if (!outcome.allowed && outcome.status === 503) adoptions.delete(key)
    return outcome
  }, (error: unknown) => {
    adoptions.delete(key)
    throw error
  })
  adoptions.set(key, attempt)
  const adopted = await attempt
  return adopted.allowed ? await refusal.reauthorize() : refusal.denial
}

export const localHostSessionAccessPolicy = remoteWorkspaceSessionAccessPolicy({
  url: () => endpoints.sessionAuthorityUrl,
  requireActor: false,
  adoptRefusedSession,
})

/** Forgets what this process has already tried to adopt; a fresh machine state is a fresh attempt. */
export function resetLocalHostSessionAdoptions() {
  adoptions.clear()
}
