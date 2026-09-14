import { importPKCS8, importSPKI } from "jose"
import { runtimeAccessTokenAlgorithm } from "@claxedo/server-core/platform/auth/runtime-access-token"

/**
 * The runtime access-token key pair, as every credential this control plane
 * signs with it reads it.
 *
 * Each credential keeps its own misconfiguration error — an operator needs to
 * know which one is unsigned — so the error is supplied rather than chosen
 * here; what is shared is the env names, the PEM normalization, and the
 * algorithm check.
 */
export type CredentialFault = (message: string) => Error

function pem(value: string | undefined) {
  const clean = value?.trim()
  return clean?.replaceAll("\\n", "\n") || undefined
}

/** A credential field that may not be blank, returned trimmed. */
export function requiredCredentialField(value: string | undefined, name: string, fault: CredentialFault) {
  const clean = value?.trim()
  if (!clean) throw fault(name)
  return clean
}

export async function runtimeTokenSigningKey(env: Record<string, string | undefined>, fault: CredentialFault) {
  const alg = runtimeAccessTokenAlgorithm(env)
  const key = requiredCredentialField(pem(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM), "runtime signing key", fault)
  return { alg, key: await importPKCS8(key, alg) }
}

export async function runtimeTokenVerificationKey(env: Record<string, string | undefined>, fault: CredentialFault) {
  const alg = runtimeAccessTokenAlgorithm(env)
  const key = requiredCredentialField(pem(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM), "runtime verification key", fault)
  return { alg, key: await importSPKI(key, alg) }
}
