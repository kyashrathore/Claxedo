import { claxedoCredentialRequest } from "@/platform/api/credential-request"
import type { CredentialKind, CredentialVerification, OnboardingCredential } from "./state"

const verificationResults: readonly CredentialVerification[] = [
  "ok",
  "auth_failed",
  "no_billing",
  "rate_capped",
  "expired",
  "unverified",
]

const credentialKinds: readonly CredentialKind[] = ["api_key", "oauth_token", "subscription_session", "sandbox_driver"]

const credentialSources = ["managed", "local_only", "env", "upstream_sync"] as const

type CredentialSource = (typeof credentialSources)[number]

export async function listOnboardingCredentials(input: {
  serverUrl: string
  machineId: string
  defaultScope: "local" | "shared"
}) {
  const res = await claxedoCredentialRequest({ serverUrl: input.serverUrl })
  const body = await res.json() as { credentials?: unknown[] }
  return (body.credentials ?? []).flatMap((value): OnboardingCredential[] => {
    if (!value || typeof value !== "object") return []
    const credential = value as Record<string, unknown>
    if (typeof credential.id !== "string" || typeof credential.provider_id !== "string") return []
    const verification = verificationResults.includes(credential.health as CredentialVerification)
      ? credential.health as CredentialVerification
      : "unverified"
    const scope = credential.scope === "local" || credential.scope === "shared" ? credential.scope : input.defaultScope
    const common = {
      id: credential.id,
      providerId: credential.provider_id,
      verification,
      // An unrecognised kind is dropped rather than passed through: sharing
      // rules read this field, and a value they cannot interpret must not be
      // mistaken for one they can.
      ...(credentialKinds.includes(credential.kind as CredentialKind) ? { kind: credential.kind as CredentialKind } : {}),
      ...(credentialSources.includes(credential.source as CredentialSource)
        ? { source: credential.source as CredentialSource }
        : {}),
      ...(typeof credential.label === "string" ? { label: credential.label } : {}),
      ...(typeof credential.account_id === "string" ? { accountId: credential.account_id } : {}),
    }
    if (scope === "shared") {
      return [{ ...common, scope }]
    }
    return [{
      ...common,
      scope,
      machineId: typeof credential.machine_id === "string" ? credential.machine_id : input.machineId,
    }]
  })
}
