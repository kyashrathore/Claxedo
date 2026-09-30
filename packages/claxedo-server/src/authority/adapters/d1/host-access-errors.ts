import type { HostConnectErrorCode } from "@claxedo/server-core/platform/auth/authority"
import type { MachineAuthRefusal } from "@claxedo/server-core/platform/auth/machine-auth"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"

export type D1HostAccessErrorCode =
  | "invalid_input"
  | "resource_conflict"
  | "host_attestation_denied"
  | "signature_replayed"
  | "host_enrollment_not_found"
  | Extract<
    MachineAuthRefusal["code"],
    "enrollment_revoked" | "enrollment_paused" | "enrollment_owner_ineligible" | "enrollment_key_version_mismatch"
  >
  | HostConnectErrorCode

const ERROR_STATUS: Record<D1HostAccessErrorCode, number> = {
  invalid_input: 400,
  resource_conflict: 409,
  host_attestation_denied: 403,
  signature_replayed: 409,
  host_enrollment_not_found: 404,
  enrollment_revoked: 403,
  enrollment_paused: 403,
  enrollment_owner_ineligible: 403,
  enrollment_key_version_mismatch: 403,
  invitation_invalid: 403,
  invitation_expired: 410,
  invitation_revoked: 410,
  invitation_redeemed: 409,
  invitation_host_conflict: 409,
  enrollment_generation_superseded: 409,
  host_assignment_outside_scope: 400,
  host_sealing_key_undeclared: 409,
  host_provider_config_revision_stale: 409,
}

export class D1HostAccessAuthorityError extends ClaxedoError<D1HostAccessErrorCode> {
  constructor(
    code: D1HostAccessErrorCode,
    message: string,
    /** Extra fields the route places beside `code` and `message` in the error body. */
    public readonly details?: Record<string, unknown>,
  ) {
    super({ code, message, status: ERROR_STATUS[code] })
  }
}
