import { errorBody } from "./routes/error-body"
import type {
  SessionAccessAuthor,
  SessionAccessDecision,
  SessionAccessPolicyInput,
  SessionRequestIdentity,
  SessionTurnOrigin,
} from "./session-access-policy"

/**
 * The two members of a request context this function reads. Narrowed to the ONE
 * key it actually asks for, so the returned claims arrive already typed instead
 * of as a union the body then had to assert its way out of.
 */
export type SessionAccessContextReader = {
  get(name: "relayHostAuth"): SessionRequestIdentity | undefined
  req?: { header(name: string): string | undefined }
}

export type SessionRequestProvenance = "loopback-direct" | "relay-replayed"

type SessionRequestProvenanceReader = SessionAccessContextReader & {
  get(name: "relayHostDirectAuth"): true | undefined
}

/**
 * Who reached this runtime, read off the request rather than off the
 * composition it was mounted with.
 *
 * Both marks are set only where a boundary verified the caller: the relay
 * host-token middleware, the owner grant, and the embedded exposure the
 * daemon ingress stamps after refusing every relayed request it cannot
 * verify. The direct mark is that middleware admitting a bearer it trusts
 * without a relay identity: the credential this runtime minted for the
 * harness it launched, its own config token on health, an agent hook
 * callback, and the token the control plane injects. None of them names an
 * actor, so the request cannot be attributed to the person at this machine's
 * keyboard and gets the private-session lifecycle instead. Only an unmarked
 * request is the machine's own user. Registration, turn admission and event
 * privacy ask this, not `SessionAccessPolicy.sessionAuthority`.
 */
export function sessionRequestProvenance(input: SessionRequestProvenanceReader): SessionRequestProvenance {
  return input.get("relayHostAuth") || input.get("relayHostDirectAuth") ? "relay-replayed" : "loopback-direct"
}

/**
 * Actor identity is read off the `relayHostAuth` mark alone, never off a
 * header the caller could write; only a boundary that verified the caller
 * sets the mark.
 */
export function sessionAccessContext(input: SessionAccessContextReader):
  Pick<SessionAccessPolicyInput, "actor" | "authority" | "credential"> & { author?: SessionAccessAuthor } {
  const auth = input.get("relayHostAuth")
  if (!auth) return {}
  const profile = auth as typeof auth & {
    actor_public_id?: string
    actor_name?: string
    actor_avatar_url?: string
  }
  const author = auth.actor_kind && profile.actor_public_id && profile.actor_name
    ? {
        author: {
          id: profile.actor_public_id,
          name: profile.actor_name,
          ...(profile.actor_avatar_url ? { avatarUrl: profile.actor_avatar_url } : {}),
          kind: auth.actor_kind,
        } satisfies SessionAccessAuthor,
      }
    : {}
  return {
    ...(input.req?.header("authorization") ? { credential: input.req.header("authorization") } : {}),
    actor: { actorId: auth.actor_id, actorKind: auth.actor_kind, ...(auth.user_id ? { userId: auth.user_id } : {}) },
    ...author,
    authority: {
      managed: true,
      workspaceId: auth.workspace_id,
      orgId: auth.org_id,
      role: auth.role,
      ...(auth.session_id ? { sessionId: auth.session_id } : {}),
      ...(auth.parent_jti ? { parentTokenId: auth.parent_jti } : {}),
    },
  }
}

type SessionHumanTurnReader = SessionAccessContextReader & {
  get(name: "machineUserRequest" | "inProcessRequest"): true | undefined
}

/**
 * Whether a turn this request starts is a person's own send, the only turn a
 * session's `lastHumanTurnAt` records.
 *
 * A relayed request names its actor's kind. A loopback request names nobody:
 * the app's send and every caller inside this process — the first-party tools
 * an agent drives, a task start, a projection read — reach the runtime alike.
 * Only the boundary that admitted it from outside the process as this
 * machine's own user can mark it, and it does so by object identity
 * (`markEmbeddedMachineUserRequest`), never by anything the caller sent.
 *
 * A request the runtime's own contribution seam built is an agent's tool call
 * even when it carries the owner grant, which names the workspace's owner as
 * a human actor so the tool may act with the owner's authority.
 */
export function sessionRequestIsHumanTurn(input: SessionHumanTurnReader): boolean {
  if (input.get("inProcessRequest")) return false
  return input.get("machineUserRequest") === true || sessionAccessContext(input).actor?.actorKind === "human"
}

/**
 * What a request admitting future background work must write down about
 * itself, or nothing when it is a relayed caller the boundary left unnamed —
 * which is work that could never be re-decided and so is never admitted.
 */
export function sessionTurnOrigin(input: SessionRequestProvenanceReader): SessionTurnOrigin | undefined {
  if (sessionRequestProvenance(input) === "loopback-direct") return { provenance: "loopback-direct" }
  const { actor, authority } = sessionAccessContext(input)
  return actor && authority ? { provenance: "relay-replayed", actor, authority } : undefined
}

export function sessionAccessDenied(decision: Exclude<SessionAccessDecision, { allowed: true }>) {
  return Response.json(errorBody(decision.code, decision.message), { status: decision.status })
}
