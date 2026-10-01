import { PUBLIC_API_ERRORS, type PublicApiErrorCode } from "@claxedo/helpers/api-error"
import { ClaxedoError } from "./base"

export class PublicApiError<Code extends PublicApiErrorCode = PublicApiErrorCode> extends ClaxedoError<Code> {
  constructor(code: Code, message: string = PUBLIC_API_ERRORS[code].message) {
    super({ code, message, status: PUBLIC_API_ERRORS[code].status })
  }
}
