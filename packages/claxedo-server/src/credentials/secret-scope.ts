import type { CredentialScope, CredentialSource } from "./types"

export type CredentialSecretScope = "local" | "shared"

export function credentialSecretInScope(input: {
  source: CredentialSource
  scope?: CredentialScope
}, scope: CredentialSecretScope = "local") {
  return scope !== "shared" || input.scope === "shared" || input.source === "managed"
}
