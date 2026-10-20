import { WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL } from "@claxedo/session-core"

/**
 * Where this runtime reaches its control plane.
 *
 * Derived from the session-authority endpoint the host is already booted with,
 * because that is the one channel a sandboxed runtime has to the plane: a
 * second URL would be a second thing to configure, a second thing to get
 * wrong, and a second egress destination to allow.
 */
export function controlPlaneOrigin(env: NodeJS.ProcessEnv): string | undefined {
  const authority = env[WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL]?.trim()
  if (!authority) return undefined
  try {
    return new URL(authority).origin
  } catch {
    return undefined
  }
}
