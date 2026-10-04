import type { AccountScope } from "@claxedo/account-contract/vocabulary"
import type { CredentialSource } from "./types"

export function credentialSecretInScope(input: {
  source: CredentialSource
  scope?: AccountScope
}, scope: AccountScope = "local") {
  return scope !== "shared" || input.scope === "shared"
}
