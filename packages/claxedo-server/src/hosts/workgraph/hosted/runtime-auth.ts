import { createRemoteJWKSet, importSPKI } from "jose"
import { verifyRuntimeAccessToken, WorkspaceRelayAuthError, type RelayKey } from "@claxedo/workspace-relay"
import { clean, type HostedWorkerEnv } from "../../../authority/adapters/worker/hosted-compose"

/**
 * Runtime Access Token verification shared by the hosted operation handlers
 * (`hosted/run-operation.ts`, `hosted/connection-operation.ts`).
 *
 * Both handlers verify a relay-minted RAT the same way, and each carried its
 * own byte-identical copy of this error class plus `failure`, `pem`,
 * `loadRuntimeKey`, and `verifyRuntimeToken`. Their `convexExecutor` and
 * `bearer` helpers, and connection-operation's provider-error mapping, are
 * genuinely different and stay local to each file.
 */
export class RuntimeAccessTokenVerificationUnavailableError extends Error {
  readonly code = "runtime_access_token_verification_unavailable"
}

export function failure(status: number, code: string, message: string, retryable: boolean) {
  return { status, code, message, retryable }
}

export function pem(input?: string) {
  return clean(input)?.replaceAll("\\n", "\n")
}

export async function loadRuntimeKey(env: HostedWorkerEnv): Promise<RelayKey> {
  const jwks = clean(env.CLAXEDO_CONTROL_PLANE_JWKS_URL)
  if (jwks) return createRemoteJWKSet(new URL(jwks))
  const publicKey = pem(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM)
  if (!publicKey) throw new Error("Runtime Access Token verification key is unavailable")
  return importSPKI(publicKey, "EdDSA")
}

export async function verifyRuntimeToken(token: string, key: Promise<RelayKey>, workspaceId: string) {
  let resolved: RelayKey
  try {
    resolved = await key
  } catch {
    throw new RuntimeAccessTokenVerificationUnavailableError()
  }
  try {
    return await verifyRuntimeAccessToken(token, resolved, { workspaceId })
  } catch (error) {
    if (error instanceof WorkspaceRelayAuthError) throw error
    throw new RuntimeAccessTokenVerificationUnavailableError()
  }
}
