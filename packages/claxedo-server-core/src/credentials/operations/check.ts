/**
 * One stored account's Check: ask the provider, then keep everything it said.
 *
 * The verifier itself never writes, and what has to be written after it —
 * a renewed access token, the verdict, the plan windows, the address the
 * provider named — is the same list wherever a Check is run from. Keeping that
 * list in one place is what stops a caller from persisting the verdict and
 * silently dropping the renewed token, which leaves every later read using the
 * stale one.
 */

import { CredentialVerificationError, verifyCredential } from "./verify"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import type { ControlPlaneCredentials } from "@claxedo/server-core/authority/control-plane-contract"
import type { CredentialHealth, CredentialMetadata, CredentialUsageWindow } from "../types"

const log = Log.create({ service: "credentials-check" })

export type CredentialCheckOutcome =
  | {
    status: "checked"
    health: CredentialHealth
    at: number
    usage?: CredentialUsageWindow[]
    /** Whether a `replace` check kept the secret it was given. Absent on an ordinary check. */
    stored?: boolean
  }
  /** This host cannot verify at all: no secret reader, or nowhere to keep a verdict. */
  | { status: "unsupported" }
  /** The row is there and its secret is not, so there is nothing to ask with. */
  | { status: "no_secret" }
  | { status: "failed"; detail: { name: string; message: string }; provider: boolean }

/** The verdicts that say the provider took the material, rather than refused it. */
const ACCEPTED = new Set<CredentialHealth>(["ok", "rate_capped", "no_billing"])

export async function checkCredential(
  credentials: ControlPlaneCredentials,
  credential: CredentialMetadata,
  options: {
    org: string
    secret?: string
    /**
     * `secret` is a replacement for this row's stored material. It is written
     * only once the provider has taken it, and nothing at all is written when
     * the provider refuses: a replacement written first deletes the backend
     * reference the working secret lives behind, so a typo leaves a good
     * account with nothing, and a verdict written first marks a working account
     * broken on the strength of the typo.
     */
    replace?: boolean
    fetch?: typeof fetch
    now?: () => number
  },
): Promise<CredentialCheckOutcome> {
  if (!credentials.updateCredentialHealth) return { status: "unsupported" }
  if (options.secret === undefined && !credentials.resolveCredentialSecretById) return { status: "unsupported" }
  if (options.replace && !credentials.updateCredentialSecret) return { status: "unsupported" }
  const verifyOptions = {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
  }
  let secret: string | undefined
  try {
    // Inside the boundary: a secret backend that refuses is this account's
    // failure, and a caller checking several accounts must reach the next one.
    secret = options.secret ?? (await credentials.resolveCredentialSecretById!(credential.id, options.org)) ?? undefined
    if (!secret) return { status: "no_secret" }
    // The stored expiry describes the material being replaced. Left in place it
    // makes the verifier read a freshly pasted secret as stale, which for an
    // API key — nothing to refresh with — answers "expired".
    const subject = options.replace ? { ...credential, expires_at: null } : credential
    const { health, refreshed, usage, accountEmail } = await verifyCredential(subject, secret, verifyOptions)
    const at = (options.now ?? Date.now)()
    if (options.replace && !ACCEPTED.has(health)) return { status: "checked", health, at, stored: false }
    // Persist first: a renewed access token that is verified but not stored
    // would make every later read fall back to the stale one.
    if (options.replace) {
      // `null` rather than nothing: the replacement's own expiry is whatever the
      // provider just said, and keeping the old one would expire a live secret.
      await credentials.updateCredentialSecret!(
        credential.id,
        refreshed?.secret ?? secret,
        refreshed?.expiresAt ?? null,
        options.org,
      )
    } else if (refreshed) {
      await credentials.updateCredentialSecret?.(credential.id, refreshed.secret, refreshed.expiresAt, options.org)
    }
    await credentials.updateCredentialHealth(credential.id, health, at, options.org)
    if (usage?.length) await credentials.updateCredentialUsage?.(credential.id, usage, at, options.org)
    await nameAccount(credentials, credential, accountEmail, options.org)
    return { status: "checked", health, at, ...(usage ? { usage } : {}), ...(options.replace ? { stored: true } : {}) }
  } catch (error: unknown) {
    return {
      status: "failed",
      detail: credentialFailureDetail(error, secret),
      provider: error instanceof CredentialVerificationError,
    }
  }
}

/**
 * What went wrong, in the two fields a caller can act on. The stack never
 * travels — only the name and the message.
 *
 * `secret` is struck from the message: a driver or platform error can quote the
 * value it was handed, and this detail is written to a log line and to an HTTP
 * body.
 */
export function credentialFailureDetail(error: unknown, secret?: string) {
  const name = error instanceof Error ? error.name : "Error"
  const message = error instanceof Error ? error.message : String(error)
  return { name, message: secret ? message.split(secret).join("[redacted]") : message }
}

/**
 * Names one row by the address the provider gave for it, unless the user has
 * already named it. A row whose only name is its provider id names the harness
 * binding, not the account, and reads identically for every login stored under
 * it.
 */
async function nameAccount(
  credentials: ControlPlaneCredentials,
  credential: Pick<CredentialMetadata, "id" | "provider_id" | "label">,
  email: string | undefined,
  org: string,
) {
  if (!email || !credentials.updateCredentialLabel) return
  const named = credential.label?.trim()
  if (named && named !== credential.provider_id) return
  await credentials.updateCredentialLabel(credential.id, email, org).catch((error: unknown) => {
    log.warn("Failed to name credential", { credential_id: credential.id, error: String(error) })
  })
}
