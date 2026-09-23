import { claxedoCredentialRequest } from "@/platform/api/credential-request"
import { readArray, readField, readString } from "@/lib/record"

export type CredentialVerification = "unverified" | "ok" | "auth_failed" | "no_billing" | "rate_capped" | "expired"

const credentialVerifications: readonly CredentialVerification[] = [
  "unverified",
  "ok",
  "auth_failed",
  "no_billing",
  "rate_capped",
  "expired",
]

/**
 * The credential routes hand these three fields back as free-form JSON, so the
 * type that declares each union also owns the check that recognises it. A value
 * the app cannot interpret is dropped at this boundary rather than carried
 * inward as a string the sharing rules would silently mis-read.
 */
export function isCredentialVerification(value: unknown): value is CredentialVerification {
  return credentialVerifications.some((entry) => entry === value)
}

export type CredentialKind = "api_key" | "oauth_token" | "subscription_session" | "sandbox_driver"

const credentialKinds: readonly CredentialKind[] = ["api_key", "oauth_token", "subscription_session", "sandbox_driver"]

export function isCredentialKind(value: unknown): value is CredentialKind {
  return credentialKinds.some((entry) => entry === value)
}

/** How a credential was obtained. */
export type CredentialSource = "managed" | "local_only" | "env" | "upstream_sync"

const credentialSources: readonly CredentialSource[] = ["managed", "local_only", "env", "upstream_sync"]

export function isCredentialSource(value: unknown): value is CredentialSource {
  return credentialSources.some((entry) => entry === value)
}

type CredentialBase = {
  id: string
  providerId: string
  verification: CredentialVerification
  /**
   * What auth material this is. Optional because a server older than the field
   * omits it; every current server sends it on both credential routes.
   */
  kind?: CredentialKind
  /** How the credential was obtained. */
  source?: CredentialSource
  /** Human name for this credential, e.g. "Claude Code login". */
  label?: string
  /** Disambiguates two credentials that share a label. */
  accountId?: string
  /** Unix ms when a rate-capped credential is expected to accept work again. */
  retryAt?: number
}

export type OnboardingCredential =
  | CredentialBase & { scope: "local"; machineId: string }
  | CredentialBase & { scope: "shared" }

export async function listOnboardingCredentials(input: {
  serverUrl: string
  machineId: string
  defaultScope: "local" | "shared"
}) {
  const res = await claxedoCredentialRequest({ serverUrl: input.serverUrl })
  const credentials = readArray(await res.json(), "credentials") ?? []
  return credentials.flatMap((value): OnboardingCredential[] => {
    const id = readString(value, "id")
    const providerId = readString(value, "provider_id")
    if (id === undefined || providerId === undefined) return []
    const health = readField(value, "health")
    const kind = readField(value, "kind")
    const source = readField(value, "source")
    const label = readString(value, "label")
    const accountId = readString(value, "account_id")
    const declaredScope = readString(value, "scope")
    const scope = declaredScope === "local" || declaredScope === "shared" ? declaredScope : input.defaultScope
    const common = {
      id,
      providerId,
      verification: isCredentialVerification(health) ? health : "unverified",
      // An unrecognised kind is dropped rather than passed through: sharing
      // rules read this field, and a value they cannot interpret must not be
      // mistaken for one they can.
      ...(isCredentialKind(kind) ? { kind } : {}),
      ...(isCredentialSource(source) ? { source } : {}),
      ...(label === undefined ? {} : { label }),
      ...(accountId === undefined ? {} : { accountId }),
    }
    if (scope === "shared") {
      return [{ ...common, scope }]
    }
    return [{
      ...common,
      scope,
      machineId: readString(value, "machine_id") ?? input.machineId,
    }]
  })
}
