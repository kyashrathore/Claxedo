/**
 * Where a request that is about to reach an embedded workspace runtime came
 * from, decided once, from facts this boundary can verify.
 *
 * A composition that serves ONE kind of caller reads only the stamp: a
 * verified actor or none. The refusals below belong to a composition that
 * serves two — see `verifyRelayIngress`.
 *
 * The daemon cannot read provenance off the socket. A request the relay
 * forwards over this machine's host tunnel is REPLAYED as a fetch the machine
 * makes to its own `127.0.0.1` listener with the remote caller's proxy headers
 * stripped (`loopbackReplayHeaders`), so it is loopback by every measure
 * `isLoopbackLocalRequest` has. What separates the two is the relay's own
 * marks on it: an `Authorization` bearer the relay minted and signed, and the
 * `x-forwarded-by` marker it sets on every forwarded request after discarding
 * whatever the client sent.
 *
 * So a relayed request is one whose bearer verifies, and a request that says
 * it came through the relay but whose bearer does not verify is REFUSED. It is
 * never treated as local: a local caller and a relayed one land on the same
 * listener, and reading an unverifiable relayed request as the machine's own
 * user would hand every session on the box to whoever could reach the tunnel.
 */

import { isLoopbackLocalRequest } from "@claxedo/server-core/platform/http/peer-address"
import { errorBody } from "@claxedo/server-core/platform/http/http"
import type { RuntimeActor } from "@claxedo/server-core/platform/auth/runtime-actor"
import { embeddedRelayHostAuthFromActor, type EmbeddedRelayHostAuth } from "./embedded-relay-host-auth"

const RELAY_FORWARDED_BY = "workspace-relay"

export type IngressActor = RuntimeActor & {
  orgId: string
  role: "viewer" | "editor" | "admin" | "owner"
}

export type IngressProvenance =
  | { kind: "loopback-direct" }
  | { kind: "relay-replayed"; stamp: EmbeddedRelayHostAuth }
  | { kind: "rejected"; response: Response }

export type IngressProvenanceOptions = {
  resolveRelayActor?: (request: Request, workspaceId: string) => Promise<IngressActor | undefined>
  /** Deployments with no local owner: every request must carry a verified actor. */
  requireRelayActor?: boolean
  /**
   * Whether an unverifiable relayed request is REFUSED rather than dispatched
   * unstamped.
   *
   * Declared by the composition because it is only answerable there: a host
   * that serves both its own user and relayed members on one loopback
   * listener, and whose runtimes admit the two differently, must refuse what
   * it cannot place. A composition whose runtimes treat every caller alike
   * gains nothing from the refusal and would lose the relayed traffic it
   * serves today, so it says so by not setting this.
   */
  verifyRelayIngress?: boolean
}

function rejected(code: string, message: string): IngressProvenance {
  return { kind: "rejected", response: Response.json(errorBody(code, message), { status: 403 }) }
}

function requestClaimsRelayIngress(request: Request) {
  return request.headers.get("x-forwarded-by") === RELAY_FORWARDED_BY
}

export async function resolveIngressProvenance(
  request: Request,
  workspaceId: string,
  options: IngressProvenanceOptions = {},
): Promise<IngressProvenance> {
  const actor = await options.resolveRelayActor?.(request, workspaceId)
  if (actor) {
    return { kind: "relay-replayed", stamp: embeddedRelayHostAuthFromActor(actor, workspaceId) }
  }
  if (options.requireRelayActor === true) {
    return rejected(
      "relay_actor_unverified",
      "A relayed workspace request requires a verified actor",
    )
  }
  if (!options.verifyRelayIngress) return { kind: "loopback-direct" }
  if (requestClaimsRelayIngress(request)) {
    return rejected(
      "relay_actor_unverified",
      "A relayed workspace request requires a verified actor",
    )
  }
  if (!isLoopbackLocalRequest(request)) {
    return rejected(
      "workspace_request_not_loopback",
      "A workspace request without a verified actor requires loopback access",
    )
  }
  return { kind: "loopback-direct" }
}
