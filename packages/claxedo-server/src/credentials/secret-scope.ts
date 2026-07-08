import type { CredentialSource } from "./types"

export type CredentialSecretScope = "local" | "shared"

export function credentialSecretInScope(input: {
  source: CredentialSource
}, scope: CredentialSecretScope = "local") {
  return scope !== "shared" || input.source === "managed"
}
