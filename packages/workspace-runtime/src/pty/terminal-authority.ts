import type { SessionAccessPolicy, SessionAccessPolicyInput } from "@claxedo/session-core"

/**
 * A terminal is the workspace's, not a session's: whoever holds a workspace
 * token with write access may open, read, type into and close any terminal on
 * it, whatever session (if any) labels the terminal. A token scoped to one
 * session, a share holder's, reaches no terminal at all.
 *
 * The role is read off the verified token; the host authority is still asked
 * on every decision because a relay host token keeps verifying after the
 * runtime access token it was minted from is revoked. Its answer carries the
 * workspace lease a long-lived socket or agent hook renews. A caller with no
 * verified authority is whatever the composition says an unstamped request
 * is: this machine's own user on a desktop daemon, nobody on a cloud runtime.
 */
export type TerminalAccess = Pick<SessionAccessPolicyInput, "actor" | "authority" | "credential"> & {
  method: string
  path: string
}

export type PtyAccessRefusal = { allowed: false; status: number; code: string; message: string }

export type TerminalAdmission = { allowed: true; lease?: string; expiresAt?: number }

export type TerminalLease = { allowed: true; lease: string; expiresAt: number }

export const PTY_SCOPE_REFUSAL: PtyAccessRefusal = {
  allowed: false,
  status: 403,
  code: "relay_scope_denied",
  message: "A token scoped to one session reaches no terminal",
}

const TERMINAL_ROLE_REFUSAL: PtyAccessRefusal = {
  allowed: false,
  status: 403,
  code: "terminal_role_denied",
  message: "A terminal needs write access to the workspace",
}

const HOST_AUTHORITY_REQUIRED: PtyAccessRefusal = {
  allowed: false,
  status: 503,
  code: "host_authority_required",
  message: "Current workspace host authority is unavailable",
}

export const TERMINAL_AUTHORITY_UNAVAILABLE: PtyAccessRefusal = {
  allowed: false,
  status: 503,
  code: "pty_stream_authority_unavailable",
  message: "Terminal stream authority is unavailable",
}

export async function authorizeTerminal(
  policy: SessionAccessPolicy | undefined,
  access: TerminalAccess,
  lease?: string,
): Promise<TerminalAdmission | PtyAccessRefusal> {
  const authority = access.authority
  if (!authority) return policy ? await policy.authorize({ ...access, operation: "pty_write" }) : { allowed: true }
  if (authority.sessionId !== undefined) return PTY_SCOPE_REFUSAL
  if (authority.role === "viewer") return TERMINAL_ROLE_REFUSAL
  if (!policy?.authorizeHost) return HOST_AUTHORITY_REQUIRED
  try {
    return await policy.authorizeHost({
      ...access,
      operation: "pty_write",
      hostAccess: "read",
      ...(lease ? { lease } : {}),
    })
  } catch {
    return TERMINAL_AUTHORITY_UNAVAILABLE
  }
}

/** A socket or hook outlives its request, so it runs only on an answer the authority put a live deadline on. */
export function terminalLease(
  decision: TerminalAdmission | PtyAccessRefusal,
  now: number,
): TerminalLease | PtyAccessRefusal {
  if (!decision.allowed) return decision
  if (!decision.lease || decision.expiresAt === undefined || !Number.isFinite(decision.expiresAt) || decision.expiresAt <= now) {
    return TERMINAL_AUTHORITY_UNAVAILABLE
  }
  return { allowed: true, lease: decision.lease, expiresAt: decision.expiresAt }
}

/**
 * The answer a create or an attach runs on: a relayed caller's carries the
 * workspace lease its socket or agent hook renews; an unstamped caller the
 * composition admits gets one with no deadline.
 */
export async function admitTerminal(
  policy: SessionAccessPolicy | undefined,
  access: TerminalAccess,
): Promise<TerminalAdmission | PtyAccessRefusal> {
  const decision = await authorizeTerminal(policy, access)
  return access.authority ? terminalLease(decision, Date.now()) : decision
}
