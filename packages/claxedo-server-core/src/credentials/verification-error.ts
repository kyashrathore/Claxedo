import { ClaxedoError } from "../platform/errors/base"
import { PUBLIC_API_ERRORS } from "@claxedo/helpers/api-error"

export type CredentialVerificationErrorCode =
  | "credential_verification_unsupported"
  | "credential_shape_invalid"
  | "credential_provider_unavailable"
  | "credential_verification_failed"
  | "credential_redirect_denied"
  | "credential_endpoint_invalid"

export class CredentialVerificationError extends ClaxedoError<CredentialVerificationErrorCode> {
  constructor(code: CredentialVerificationErrorCode, message: string = PUBLIC_API_ERRORS[code].message) {
    super({ code, message, status: PUBLIC_API_ERRORS[code].status, retryable: code === "credential_provider_unavailable" })
  }
}
