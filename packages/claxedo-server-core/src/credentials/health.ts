import type { CredentialHealth, CredentialMetadata, CredentialStatus, CredentialVerdictEvidence } from "./types"

/**
 * The verdicts that end an account: the vendor said the material is not
 * accepted or cannot spend. `rate_capped` is not one of them — the vendor
 * took the credential and asked for time — so a throttled account keeps
 * running turns and keeps its active mark.
 */
export const REFUSED_HEALTHS: readonly CredentialHealth[] = ["auth_failed", "no_billing", "expired"]

export function isRefusedHealth(health: CredentialHealth): boolean {
  return REFUSED_HEALTHS.includes(health)
}

/** The lifecycle status a verdict leaves a row in; revocation is the store's to preserve. */
export function credentialStatusForHealth(health: CredentialHealth): CredentialStatus {
  if (health === "expired") return "expired"
  return isRefusedHealth(health) ? "error" : "available"
}

/**
 * Why a stored row cannot be spent, or nothing when it can. The health is
 * preferred over the status because a health verdict names what the vendor
 * said (`auth_failed`, `no_billing`) where the status only records that
 * something went wrong, and every surface that refuses an account names the
 * reason with this one word.
 */
export function credentialUnavailableReason(row: Pick<CredentialMetadata, "status" | "health">): string | undefined {
  return row.status === "available" ? undefined : row.health ?? row.status
}

/** The `last_error` a verdict leaves on its row: the verdict and, when the vendor's answer is known, its status and error type. */
export function credentialLastError(health: CredentialHealth, evidence?: CredentialVerdictEvidence): string | null {
  if (health === "ok") return null
  if (!evidence) return health
  const retry = evidence.retryAfterSeconds === undefined ? "" : `, retry after ${evidence.retryAfterSeconds} s`
  return `${health}: ${evidence.status}${evidence.type ? ` ${evidence.type}` : ""}${retry}`
}
