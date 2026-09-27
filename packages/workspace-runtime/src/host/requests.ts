import { ElicitationValidationError, isRecord, type AgentPermission, type AgentQuestion, type AgentSessionStartBinding } from "@claxedo/agent-runtime-contract"
import type { createRequestBroker } from "@claxedo/harness/broker"
import type { AnswerResult, PendingRequest, RequestAnswer } from "@claxedo/harness/contract"
import { AgentRuntimeRequestRefusedError, type AgentRuntimeInteractionResult, type AgentRuntimePermissionDecision, type AgentRuntimeStore } from "./contracts"

export type RequestTarget = { sessionId: string } | { start: AgentSessionStartBinding }

/** The one field of a single-answer form response; `undefined` for every other shape. */
function soleAnswer(answers: readonly string[][]) {
  const [only] = answers
  return answers.length === 1 && only?.length === 1 ? only[0] : undefined
}

function formValues(sole: string): Readonly<Record<string, unknown>> {
  let content: unknown
  try {
    content = JSON.parse(sole)
  } catch {
    throw new ElicitationValidationError("invalid_answer", "Elicitation response must be a JSON object")
  }
  if (!isRecord(content)) throw new ElicitationValidationError("invalid_answer", "Elicitation response must be a JSON object")
  return content
}

/**
 * The wire's question reply, as the broker takes it. A question keeps its
 * answer rows; an elicitation is one form object or one explicit consent, and
 * an empty reply declines whatever was asked.
 */
export function questionReplyAnswer(pending: PendingRequest | undefined, answers: readonly string[][]): RequestAnswer {
  if (answers.length === 0) return { kind: "rejected" }
  const request = pending?.request
  if (!request || request.kind === "question") return { kind: "answers", answers: answers.map((row) => [...row]) }
  if (request.kind === "permission") throw new ElicitationValidationError("invalid_answer", "A permission takes a decision, not answers")
  const sole = soleAnswer(answers)
  if (request.mode === "url") {
    if (sole === undefined) throw new ElicitationValidationError("invalid_answer", "URL elicitation requires explicit consent")
    return { kind: "consent", accepted: true }
  }
  if (sole === undefined) throw new ElicitationValidationError("invalid_answer", "Elicitation requires one structured form response")
  return { kind: "form", values: formValues(sole) }
}

function settled(result: AnswerResult): AgentRuntimeInteractionResult {
  if (!result.ok) throw new AgentRuntimeRequestRefusedError(result.refusal, result.retryable, result.message)
  return { events: [] }
}

/**
 * Pending requests and their answers, through the one request broker of this
 * store. The store's pending rows are the listing: the broker publishes each
 * ask into them and saves every answer before the harness is released. A
 * listing first lets the broker retire the rows no live owner can answer.
 */
export function createRequestSurface(input: { store: AgentRuntimeStore; broker: ReturnType<typeof createRequestBroker> }) {
  const { store, broker } = input

  const pendingFor = (sessionId: string, requestId: string): PendingRequest | undefined =>
    broker.broker.list({ sessionId }).find((row) => row.request.requestId === requestId)

  const targetOf = (sessionId: string, start: AgentSessionStartBinding | undefined): RequestTarget => start ? { start } : { sessionId }

  return {
    permissions: {
      async list(directory: string): Promise<AgentPermission[]> {
        broker.broker.list({ directory })
        return store.listPermissions(directory)
      },
      async respond(
        permissionId: string,
        decision: AgentRuntimePermissionDecision,
        directory: string,
        optionId?: string,
      ): Promise<AgentRuntimeInteractionResult> {
        const permission = store.listPermissions(directory).find((item) => item.id === permissionId)
        if (!permission) throw new Error(`Permission ${permissionId} not found`)
        return settled(await broker.broker.answer(permissionId,
          { kind: "permission", decision, ...(optionId === undefined ? {} : { optionId }) },
          { sessionId: permission.sessionID }))
      },
    },
    questions: {
      async list(directory: string): Promise<AgentQuestion[]> {
        broker.broker.list({ directory })
        return store.listQuestions(directory)
      },
      async answer(
        questionId: string,
        answers: readonly string[][],
        sessionId: string,
        start?: AgentSessionStartBinding,
      ): Promise<AgentRuntimeInteractionResult> {
        const answer = questionReplyAnswer(pendingFor(sessionId, questionId), answers)
        return settled(await broker.broker.answer(questionId, answer, targetOf(sessionId, start)))
      },
      async reject(questionId: string, sessionId: string, start?: AgentSessionStartBinding): Promise<AgentRuntimeInteractionResult> {
        return settled(await broker.broker.answer(questionId, { kind: "rejected" }, targetOf(sessionId, start)))
      },
    },
  }
}
