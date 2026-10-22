/**
 * How a host runtime admits the owner's Runtime Access Token presented to it
 * directly. The signature is checked against the control plane's key set;
 * whether the token still stands is the control plane's host authority's
 * answer, remembered per token for as long as the relay remembers the same
 * answer, so a revocation reaches the direct route no later than the relay
 * route.
 */

import { createRemoteJWKSet } from "jose"
import type { SessionAccessPolicy } from "@claxedo/session-core"
import type { RuntimeAccessAdmission, RuntimeAccessTokenState } from "@claxedo/session-core/relay-host"

export const RUNTIME_ACCESS_STATE_TTL_MS = 10_000
const REMEMBERED_TOKENS = 256
const STATE_UNAVAILABLE = "runtime_access_token_state_unavailable"

type Remembered = { expiresAt: number; state: Promise<RuntimeAccessTokenState> }

async function askControlPlane(policy: Pick<SessionAccessPolicy, "authorizeHost">, token: string): Promise<RuntimeAccessTokenState> {
  const decision = await policy.authorizeHost?.({ credential: `Bearer ${token}`, operation: "worktree_read", hostAccess: "read" })
  if (!decision) return { active: false, code: STATE_UNAVAILABLE, message: "This host has no authority to ask whether the token stands" }
  if (decision.allowed) return { active: true }
  return { active: false, code: decision.status === 503 ? STATE_UNAVAILABLE : decision.code, message: decision.message }
}

function forgetExpired(remembered: Map<string, Remembered>, at: number) {
  for (const [jti, entry] of remembered) {
    if (entry.expiresAt <= at || remembered.size >= REMEMBERED_TOKENS) remembered.delete(jti)
  }
}

export function runtimeAccessAdmission(input: {
  jwksUrl: string
  policy: Pick<SessionAccessPolicy, "authorizeHost">
  now?: () => number
}): RuntimeAccessAdmission {
  const now = input.now ?? Date.now
  const remembered = new Map<string, Remembered>()
  return {
    key: createRemoteJWKSet(new URL(input.jwksUrl)),
    active: ({ token, claims }) => {
      const at = now()
      const hit = remembered.get(claims.jti)
      if (hit && hit.expiresAt > at) return hit.state
      forgetExpired(remembered, at)
      const state = askControlPlane(input.policy, token)
      const entry = { expiresAt: at + RUNTIME_ACCESS_STATE_TTL_MS, state }
      remembered.set(claims.jti, entry)
      void state.then((answer) => {
        if (!answer.active && answer.code === STATE_UNAVAILABLE && remembered.get(claims.jti) === entry) remembered.delete(claims.jti)
      })
      return state
    },
  }
}
