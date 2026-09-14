import { decodeJwt } from "jose"
import { workspaceRuntimeOwnerGrantToken } from "@claxedo/server-core/hosts/workspace-runtime/env"

export type WorkspaceRuntimeOwnerGrant = Readonly<{
  /** The user the grant names, read without verifying: it seeds audit records, and the control plane verifies. */
  readonly userId: string | undefined
  readonly expiresAt: number | undefined
  /** The grant while it is live; nothing once it has expired, so an in-process call carries no dead bearer. */
  current(): string | undefined
  /** Takes a renewed grant in place, so every later call presents it. */
  swap(token: string): void
}>

/** The claims a control-plane-minted grant carries, read without verifying; nothing for a token that is not a JWT. */
function claims(token: string): { userId?: string; expiresAt?: number } {
  try {
    const payload = decodeJwt(token)
    return {
      ...(typeof payload.user_id === "string" && payload.user_id ? { userId: payload.user_id } : {}),
      ...(typeof payload.exp === "number" ? { expiresAt: payload.exp * 1_000 } : {}),
    }
  } catch {
    return {}
  }
}

/**
 * The owner grant this runtime was launched with, as the first-party MCP
 * contribution presents it on its in-process calls.
 *
 * Absent whenever the control plane minted none: the root's project has
 * subagents off, and its sessions act as nobody on their own runtime, which is
 * how a child create there is refused. The token is swapped in place by the
 * Tasks grant's renewal, which carries a fresh owner grant beside it.
 */
export function workspaceRuntimeOwnerGrant(
  env: Record<string, string | undefined>,
  options: { now?: () => number } = {},
): WorkspaceRuntimeOwnerGrant | undefined {
  const initial = workspaceRuntimeOwnerGrantToken(env)
  if (!initial) return undefined
  const now = options.now ?? Date.now
  let token = initial
  let { userId, expiresAt } = claims(initial)
  return {
    get userId() {
      return userId
    },
    get expiresAt() {
      return expiresAt
    },
    current: () => (expiresAt !== undefined && now() >= expiresAt ? undefined : token),
    swap: (next) => {
      token = next
      const renewed = claims(next)
      userId = renewed.userId
      expiresAt = renewed.expiresAt
    },
  }
}
