import type { AuthIdentity } from "@claxedo/server-core/platform/auth/authentication"
import { AUTH_ADAPTERS } from "@claxedo/account-contract/auth"
import { requireText } from "./access-context"
import { D1WorkspaceAuthorityError } from "./workspace-authority-error"

export const USER_DEPLOYED_OWNER_CLAIM_HEADER = "x-claxedo-bootstrap-owner-claim"

export function validateIdentity(identity: AuthIdentity) {
  if (!AUTH_ADAPTERS.includes(identity.adapter)) {
    throw new D1WorkspaceAuthorityError("invalid_input", "Unknown authentication adapter")
  }
  requireText(identity.issuer, "identity.issuer")
  requireText(identity.subject, "identity.subject")
}

export function sameIdentity(a: AuthIdentity, b: AuthIdentity) {
  return a.adapter === b.adapter && a.issuer === b.issuer && a.subject === b.subject
}

export function requireBootstrapClaim(value: string) {
  if (value.trim() !== value || !/^[A-Za-z0-9_-]{43,128}$/.test(value)) {
    throw new D1WorkspaceAuthorityError(
      "invalid_input",
      "Bootstrap owner claim must be a canonical 256-bit-or-stronger base64url value",
    )
  }
  return value
}

export async function userDeployedOwnerBootstrapClaimHash(claim: string) {
  const canonical = requireBootstrapClaim(claim)
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)))
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

/** Stable hash recorded by the release admission and bootstrap claim rows. */
export async function userDeployedOwnerIdentityHash(identity: AuthIdentity) {
  validateIdentity(identity)
  const canonical = JSON.stringify([
    "claxedo:user-deployed-owner:v1",
    identity.adapter,
    identity.issuer,
    identity.subject,
  ])
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)))
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}
