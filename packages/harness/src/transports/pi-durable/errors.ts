import { EDGE_REFUSED_MESSAGE, vendorBody, type FirstTurnErrorClass } from "@claxedo/agent-runtime-contract"
import { TransportError } from "../../contract/errors"

export const piConfiguration = (message: string, detail?: Readonly<Record<string, string>>) =>
  new TransportError("pi", "configuration", message, { retryable: false, ...(detail ? { detail } : {}) })

export const piSession = (message: string) => new TransportError("pi", "session", message, { retryable: false })

export const piCredentialExpired = (providerId: string) =>
  piConfiguration(`credential_expired: Claxedo has no renewed ${providerId} sign-in for this Pi session`, { reason: "credential_expired", providerId })

export const piDirectCredentialRequired = (providerId: string) =>
  piConfiguration(`direct_credential_required: Pi needs a connected ${providerId} account for this session`,
    { reason: "direct_credential_required", providerId })

export type PiModelFailure = { error: string; errorClass?: FirstTurnErrorClass }

export function piModelFailure(record: { reason: string; detail?: unknown }): PiModelFailure {
  const detail = typeof record.detail === "string" && record.detail ? record.detail : undefined
  if (detail && vendorBody(detail).kind === "page") return { error: EDGE_REFUSED_MESSAGE, errorClass: "egress" }
  return { error: detail ?? `Pi left the turn unanswered: ${record.reason}` }
}

export function piRetryMessage(errorMessage: string | undefined): string {
  if (!errorMessage) return "Pi is retrying the model request"
  return vendorBody(errorMessage).kind === "page" ? EDGE_REFUSED_MESSAGE : errorMessage
}
