import { claxedoCredentialRequest } from "@/platform/api/credential-request"
import { readArray, readField, readString } from "@/lib/record"
import {
  isCredentialKind,
  isCredentialSource,
  isCredentialVerification,
  type OnboardingCredential,
} from "./state"

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
