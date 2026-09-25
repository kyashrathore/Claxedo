import {
  ElicitationValidationError,
  elicitationPatternChecks,
  readElicitationSchema,
  validateElicitationResponse,
} from "@claxedo/agent-runtime-contract"
import type { RequestAnswer, TurnRequest } from "../../contract/broker"
import type { BrokerPorts } from "../ports"

export async function validateRequest(ports: BrokerPorts, request: TurnRequest, signal?: AbortSignal): Promise<void> {
  if (request.kind !== "elicitation" || request.mode !== "form") return
  let schema: ReturnType<typeof readElicitationSchema>
  try {
    schema = readElicitationSchema(request.schema)
    await ports.services.patternEvaluator(elicitationPatternChecks(schema), signal)
  } catch (error) {
    if (error instanceof ElicitationValidationError && error.code === "invalid_schema") throw error
    throw new ElicitationValidationError("invalid_schema", error instanceof Error ? error.message : "Invalid form schema")
  }
}

export async function validateAnswer(
  ports: BrokerPorts,
  request: TurnRequest,
  answer: RequestAnswer,
  signal: AbortSignal,
): Promise<void> {
  if (answer.kind === "cancelled" || answer.kind === "expired" || answer.kind === "rejected") return
  if (request.kind === "permission") {
    if (answer.kind !== "permission") throw new ElicitationValidationError("invalid_answer", "Permission decision required")
    return
  }
  if (request.kind === "question") {
    if (answer.kind !== "answers") throw new ElicitationValidationError("invalid_answer", "Question answers required")
    if (answer.answers.length !== request.question.questions.length) {
      throw new ElicitationValidationError("invalid_answer", "Answer count does not match questions")
    }
    return
  }
  if (request.mode === "url") {
    if (answer.kind !== "consent") throw new ElicitationValidationError("invalid_answer", "URL consent required")
    return
  }
  if (answer.kind !== "form") throw new ElicitationValidationError("invalid_answer", "Form response required")
  const schema = readElicitationSchema(request.schema)
  await validateElicitationResponse(schema, answer.values, ports.services.patternEvaluator, signal)
  if (signal.aborted) throw new ElicitationValidationError("validation_cancelled", "Form validation was cancelled")
}
