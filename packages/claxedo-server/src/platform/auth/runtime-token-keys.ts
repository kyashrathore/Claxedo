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

/** The fault one credential raises for what its deployment lacks, in that credential's own error class. */
export function credentialFault(credential: string, error: new (message: string) => Error): CredentialFault {
  return (name) => new error(`${credential} requires ${name}`)
}

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
  requiredCredentialField(pem(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM), "runtime verification key", fault)
  // jose imports keys non-extractable by default, and deriving the published `kid` exports this one.
  return { alg, key: await importPKCS8(key, alg, { extractable: true }) }
}

export async function runtimeTokenVerificationKey(env: Record<string, string | undefined>, fault: CredentialFault) {
  const alg = runtimeAccessTokenAlgorithm(env)
  const key = requiredCredentialField(pem(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM), "runtime verification key", fault)
  return { alg, key: await importSPKI(key, alg) }
}
