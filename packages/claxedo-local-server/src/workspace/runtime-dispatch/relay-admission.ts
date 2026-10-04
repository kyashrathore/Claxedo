/**
 * Whether the daemon's admission gate should let a capability-less request
 * reach this dispatcher.
 *
 * The host tunnel replays a relayed org member's request as a fetch this
 * machine makes to its own listener, so it carries no application capability
 * and looks entirely local. This supplies the BOUND on admitting it: never
 * "does it say it came through the relay?", which is a header anyone reaching
 * the port can set and would carry them into the file, shell, credential and
 * machine-control families. Both axes are narrowed instead — the path must be
 * one this dispatcher answers for a named workspace, and the relay's signature
 * must verify for that workspace. `resolveIngressProvenance` is the verifier,
 * memoized against the request, so admission and the dispatch hop moments later
 * cannot reach different verdicts.
 */

import { requestWorkspace, runtimeOwned, type RuntimeProxyOptions } from "./internals"
import { resolveIngressProvenance } from "./ingress-provenance"

/** The mounted relay-shaped surface, `/workspaces/:workspaceId/...`. */
const MOUNTED_WORKSPACE = /^\/workspaces\/([^/]+)(?:\/|$)/

function dispatchedWorkspaceId(request: Request): string | undefined {
  const mounted = MOUNTED_WORKSPACE.exec(new URL(request.url).pathname)
  if (mounted?.[1]) {
    try {
      return decodeURIComponent(mounted[1])
    } catch {
      return mounted[1]
    }
  }
  return runtimeOwned(new URL(request.url).pathname) ? requestWorkspace(request).workspaceId : undefined
}

/**
 * `undefined` is "not a relayed caller", leaving the gate its own refusal. A
 * refusal here is the ingress's, forwarded verbatim, so a request bearing relay
 * marks the relay never signed is told that rather than told it lacked a
 * capability it was never going to have.
 */
export type RelayReplayAdmission = { admit: true } | { refuse: Response }

export async function relayReplayAdmission(
  request: Request,
  options: RuntimeProxyOptions,
): Promise<RelayReplayAdmission | undefined> {
  if (!options.resolveRelayActor) return undefined
  const workspaceId = dispatchedWorkspaceId(request)
  // The host aggregate stream names no workspace, and a relay token is minted
  // for one. There is nothing here to verify against, so it stays the
  // application's own.
  if (!workspaceId) return undefined
  const provenance = await resolveIngressProvenance(request, workspaceId, {
    resolveRelayActor: options.resolveRelayActor,
    ...(options.requireRelayActor ? { requireRelayActor: true } : {}),
    verifyRelayIngress: true,
  })
  if (provenance.kind === "relay-replayed") return { admit: true }
  if (provenance.kind === "rejected") return { refuse: provenance.response }
  return undefined
}
