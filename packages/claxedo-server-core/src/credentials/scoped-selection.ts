import type { AccountScope } from "@claxedo/account-contract/vocabulary"
import { fanoutEligible } from "./account-kinds"
import { SINGLE_TENANT_ORG } from "./partition"
import { activeCredentials, type CredentialOrgScope, type CredentialRead } from "./registry"
import { credentialSecretInScope } from "./secret-scope"
import type { CredentialMetadata } from "./types"

export type ScopedCredentialSelection = {
  credential: CredentialMetadata
  /** Absent when the account can be used; otherwise why it cannot. */
  unavailable?: string
}

/**
 * Every account the operator marked for a provider in this scope, usable or
 * not, without secrets. This is the only place "which credential runs" is
 * answered, so a surface that shows it reads the same selection.
 *
 * The scope filter runs after the mark, not instead of it: a user whose active
 * account is not shared sends nothing into a sandbox even when another of their
 * accounts would qualify, because silently running a sandbox on an account the
 * user did not choose is the thing the mark exists to stop.
 *
 * A withdrawn row stays in the answer with its reason. Dropping it would make
 * "no account chosen" and "the chosen account is unusable" indistinguishable,
 * and the harness then runs on whatever login its machine holds. A caller that
 * can only consume a working credential passes the answer through
 * `usableCredentials`.
 */
export function activeCredentialsForScope(
  scope: AccountScope,
  read: CredentialRead,
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
): ScopedCredentialSelection[] {
  return activeCredentials(read, org)
    .filter((credential) => fanoutEligible(credential) && credentialSecretInScope(credential, scope))
    .map((credential) => {
      const unavailable = credentialUnavailableForScope(credential, scope)
      return unavailable ? { credential, unavailable } : { credential }
    })
}

/** The rows of a selection the fanout can send, one per provider. */
export function usableCredentials(rows: readonly ScopedCredentialSelection[]): CredentialMetadata[] {
  return rows.flatMap((row) => (row.unavailable ? [] : [row.credential]))
}

/**
 * Why an in-scope account cannot be used, or `undefined` when it can. The
 * health is preferred over the status because a health verdict names what the
 * provider said (`auth_failed`, `no_billing`) where the status only records
 * that something went wrong.
 */
export function credentialUnavailableForScope(
  credential: CredentialMetadata,
  scope: AccountScope,
): string | undefined {
  if (!credential.secure_ref) return "no_secret"
  if (credential.health === "expired") return "expired"
  if (credential.expires_at != null && credential.expires_at <= Date.now()) return "expired"
  if (credential.status !== "available") return credential.health ?? credential.status
  if (scope === "shared" && !credential.consent) return "consent_required"
  return undefined
}
