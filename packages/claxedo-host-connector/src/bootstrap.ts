/**
 * First boot of a `claxedo connect` host: turn an invitation file into an
 * enrollment, durably.
 *
 * The order of writes is the recovery story. The key, the control-plane URL
 * and the `bootstrap` marker reach disk BEFORE the redeem request leaves, so a
 * redeem that committed at the control plane but whose answer never arrived is
 * recovered on the next boot by redeeming again with the same key — the
 * control plane answers `resumed: true` for the same key and host id instead
 * of `invitation_redeemed`. Only after the enrollment is on disk is the token
 * file removed and the marker cleared.
 */

import { hostInvitationRedeemPayload, parseInvitationToken, hostPublicKeyFingerprint, type HostKeyPair } from "./host-identity"
import { isPlainRecord, type HostState, type HostStateStore } from "./host-state"
import {
  HOST_ENROLLMENT_REDEEM_PATH,
  HostedHttpError,
  controlPlaneRequestUrl,
  decisionCode,
  decodeEndpoints,
  decodeScope,
  postJson,
  requireNumber,
  requireString,
  type FetchLike,
} from "./machine-transport"

/** EX_CONFIG: the operator has to change something; a service manager must not restart into it. */
export const DECISION_EXIT_CODE = 78

/**
 * A refusal the control plane decided, as opposed to a transport failure that
 * a retry may outlive. Carries the exit code so the CLI and the service unit
 * agree on what "do not restart" looks like.
 */
export class HostConnectDecisionError extends Error {
  readonly exitCode = DECISION_EXIT_CODE
  readonly code: string | undefined
  readonly status: number | undefined
  constructor(message: string, input: { code?: string; status?: number; cause?: unknown }) {
    super(message, input.cause === undefined ? undefined : { cause: input.cause })
    this.name = "HostConnectDecisionError"
    this.code = input.code
    this.status = input.status
  }
}

const DECISION_STATUSES = new Set([400, 401, 403, 404, 409, 410])

/** Wrap a control-plane refusal as a decision; anything else is the caller's to retry. */
export function asDecision(error: unknown): HostConnectDecisionError | undefined {
  if (error instanceof HostConnectDecisionError) return error
  if (!(error instanceof HostedHttpError) || !DECISION_STATUSES.has(error.status)) return undefined
  const code = decisionCode(error)
  return new HostConnectDecisionError(code ? `control plane refused: ${code}` : error.message, {
    ...(code ? { code } : {}),
    status: error.status,
    cause: error,
  })
}

export type RedeemOutcome = { state: HostState; resumed: boolean }

export async function redeemInvitation(input: {
  tokenFile: string
  store: HostStateStore
  /** Key, `control_plane_url`, roots and storage root; no enrollment yet. */
  state: HostState
  keys: HostKeyPair
  displayName?: string
  fetch: FetchLike
  now?: () => number
}): Promise<RedeemOutcome> {
  if (input.state.enrollment) {
    throw new HostConnectDecisionError(
      `this host is already enrolled as ${input.state.enrollment.enrollment_id}; reset its state to enroll again`,
      {},
    )
  }
  const tokenText = await input.store.fs.readFile(input.tokenFile)
  if (tokenText === null) {
    throw new HostConnectDecisionError(`invitation token file not found: ${input.tokenFile}`, {})
  }
  const token = parseInvitationToken(tokenText)
  if (input.state.bootstrap && input.state.bootstrap.invitation_id !== token.invitationId) {
    // "resume" applies only to the invitation that created the enrollment;
    // a different invitation while the first is unresolved would enroll the
    // same host id twice and be refused as a host conflict anyway.
    throw new HostConnectDecisionError(
      `a redeem of invitation ${input.state.bootstrap.invitation_id} is still pending; finish or reset it before using another invitation`,
      {},
    )
  }

  const pending: HostState = {
    ...input.state,
    bootstrap: { invitation_id: token.invitationId, token_file: input.tokenFile },
  }
  await input.store.save(pending)

  const publicKeySha256 = await hostPublicKeyFingerprint(input.keys.publicKey)
  const bodyText = JSON.stringify({
    invitationId: token.invitationId,
    secret: token.secret,
    hostId: pending.host_id,
    publicKey: input.keys.publicKey,
    signature: await input.keys.sign(
      hostInvitationRedeemPayload({ invitationId: token.invitationId, hostId: pending.host_id, publicKeySha256 }),
    ),
    ...(input.displayName ? { displayName: input.displayName } : {}),
  })
  let value: unknown
  try {
    value = await postJson(input.fetch, controlPlaneRequestUrl(pending.control_plane_url, HOST_ENROLLMENT_REDEEM_PATH), bodyText, {})
  } catch (error) {
    throw asDecision(error) ?? error
  }
  if (!isPlainRecord(value) || !isPlainRecord(value.enrollment)) throw new Error("redeem returned no enrollment")
  const enrollmentId = requireString(value.enrollment.enrollment_id, "enrollment.enrollment_id")
  const hostId = requireString(value.enrollment.host_id, "enrollment.host_id")
  if (hostId !== pending.host_id) {
    throw new Error(`redeem enrolled host ${hostId}, but this host is ${pending.host_id}`)
  }
  const scope = decodeScope(value.scope)
  const enrolled: HostState = {
    ...pending,
    enrollment: {
      enrollment_id: enrollmentId,
      owner_display: typeof value.owner_display_name === "string" ? value.owner_display_name : "",
      org_id: typeof value.org_id === "string" ? value.org_id : "",
      enrolled_via: "invitation",
      enrolled_at: typeof value.enrollment.created_at === "number" ? value.enrollment.created_at : (input.now ?? Date.now)(),
      key_version: requireNumber(value.key_version, "key_version"),
    },
    ...decodeEndpoints(value),
    ...(scope ? { scope } : {}),
  }
  await input.store.save(enrolled)
  const state = await input.store.finishPendingCleanup(enrolled)
  return { state, resumed: value.resumed === true }
}
