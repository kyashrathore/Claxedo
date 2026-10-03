export type CredentialDiscoveryErrorCode =
  | "discovery_not_found"
  | "discovery_expired"
  | "discovery_item_not_found"
  | "discovery_duplicate_item"
  | "discovery_org_mismatch"

export class CredentialDiscoveryError extends Error {
  constructor(public readonly code: CredentialDiscoveryErrorCode) {
    super(`credential discovery failed: ${code}`)
    this.name = "CredentialDiscoveryError"
  }
}
