import { publicApiErrorShape } from "@claxedo/helpers/api-error"
import type { HostConnectErrorCode } from "@claxedo/server-core/platform/auth/host-connect-contract"
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


export class D1HostAccessAuthorityError extends ClaxedoError<D1HostAccessErrorCode> {
  constructor(
    code: D1HostAccessErrorCode,
    message: string,
    /** Extra fields the route places beside `code` and `message` in the error body. */
    public readonly details?: Record<string, unknown>,
  ) {
    super({ code, message, ...publicApiErrorShape(code) })
  }
}
