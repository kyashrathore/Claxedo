import { claxedoCredentialRequest } from "@/platform/api/credential-request"
import type { CredentialVerification, OnboardingCredential } from "./state"

const verificationResults: readonly CredentialVerification[] = [
  "ok",
  "auth_failed",
  "no_billing",
  "rate_capped",
  "expired",
  "unverified",
]

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
    if (scope === "shared") {
      return [{ id: credential.id, providerId: credential.provider_id, verification, scope }]
    }
    return [{
      id: credential.id,
      providerId: credential.provider_id,
      verification,
      scope,
      machineId: typeof credential.machine_id === "string" ? credential.machine_id : input.machineId,
    }]
  })
}
