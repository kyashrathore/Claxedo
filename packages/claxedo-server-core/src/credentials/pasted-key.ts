import { createHash } from "crypto"
import { fanoutEligibleAuth } from "./account-kinds"
import type { CredentialWrite } from "./types"

const PREFIX_LIMIT = 7
const VISIBLE_TAIL = 4
const SHORTEST_HINTED_SECRET = 16
const VENDOR_PREFIX = /^(?:[a-z]{2,}[-_])+/

/**
 * The identity a pasted key carries when the provider gives none.
 *
 * The upsert key includes `account_id`, so two keys saved without one are the
 * same row: hashing the secret makes them two rows, and the same key saved
 * twice idempotent. The trailing characters are the ones the provider's own
 * dashboard shows, so the row is recognisable in the accounts list without ever
 * revealing the key.
 *
 * Keyed on the caller's kind rather than the stored one: a pasted setup token
 * settles under `oauth_token` and still names no account. Logins that arrive
 * from an OAuth flow carry the provider's account id already, and everything
 * that is not harness auth (sandbox drivers, `integration:` and `channel:`
 * secrets) has one row per provider by design.
 */
export function pastedAccountId(input: CredentialWrite): string | undefined {
  if (input.kind !== "api_key" || !fanoutEligibleAuth(input.kind, input.provider_id)) return undefined
  return `fp_${createHash("sha256").update(input.secret).digest("hex").slice(0, 8)}…${input.secret.slice(-4)}`
}

/**
 * What the accounts list may show of a pasted API key: the vendor's public
 * prefix (`sk-ant-`, `key_`) and the last four characters, joined by `…`.
 *
 * The prefix is only whole lowercase segments ending in `-` or `_` within the
 * first seven characters, so a key with no vendor prefix shows none rather
 * than some of its random part. A key shorter than sixteen characters gets no
 * hint at all: prefix and tail would be most of it. The tail is the one the
 * fingerprint `account_id` already carries.
 */
export function secretHint(input: Pick<CredentialWrite, "kind" | "provider_id" | "secret">): string | undefined {
  if (input.kind !== "api_key" || !fanoutEligibleAuth(input.kind, input.provider_id)) return undefined
  if (input.secret.length < SHORTEST_HINTED_SECRET) return undefined
  return `${vendorPrefix(input.secret)}…${input.secret.slice(-VISIBLE_TAIL)}`
}

function vendorPrefix(secret: string): string {
  return VENDOR_PREFIX.exec(secret.slice(0, PREFIX_LIMIT))?.[0] ?? ""
}
