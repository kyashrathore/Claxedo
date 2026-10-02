import { ElicitationValidationError } from "@claxedo/agent-runtime-contract"
import { errorBody } from "./error-body"

/** Only validation failures are client errors; persistence/transport failures retain their server semantics. */
export function elicitationError(error: unknown) {
  if (!(error instanceof ElicitationValidationError)) return undefined
  const status: 400 | 409 | 422 | 503 = error.code === "invalid_answer" ? 400
    : error.code === "validation_unavailable" ? 503
    : error.code === "validation_busy" || error.code === "validation_cancelled" ? 409 : 422
  return { body: errorBody(`elicitation_${error.code}`, error.message), status }
}
