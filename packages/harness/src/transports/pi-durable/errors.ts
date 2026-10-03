import { TransportError } from "../../contract/errors"

export const piConfiguration = (message: string, detail?: Readonly<Record<string, string>>) =>
  new TransportError("pi", "configuration", message, { retryable: false, ...(detail ? { detail } : {}) })

export const piSession = (message: string) => new TransportError("pi", "session", message, { retryable: false })

export const piCredentialRefused = (message: string) => piConfiguration(message)

export const piCredentialExpired = (providerId: string) =>
  piConfiguration(`credential_expired: Claxedo has no renewed ${providerId} sign-in for this Pi session`, { reason: "credential_expired", providerId })

export const piDirectCredentialRequired = (providerId: string) =>
  piConfiguration(`direct_credential_required: Pi needs a connected ${providerId} account for this session`,
    { reason: "direct_credential_required", providerId })

export function piModelError(record: { reason: string; detail?: unknown }): string {
  return typeof record.detail === "string" && record.detail ? record.detail : `Pi left the turn unanswered: ${record.reason}`
}
