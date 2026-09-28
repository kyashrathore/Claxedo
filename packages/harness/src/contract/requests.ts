import type { AgentPermission, AgentQuestion, PermissionDecision } from "@claxedo/agent-runtime-contract"
import type { ElicitationRequest, PermissionOption, PermissionRequest, QuestionRequest, RequestAnswer } from "./broker"

type PermissionInput = {
  requestId?: string
  sessionId: string
  permission: string
  title?: string
  patterns?: readonly string[]
  always?: readonly string[]
  metadata?: Readonly<Record<string, unknown>>
  harnessPayload?: unknown
  options?: readonly PermissionOption[]
  grantKey?: string
  expiresAt?: number
  envelope?: Partial<AgentPermission>
}

export function permissionRequest(input: PermissionInput): PermissionRequest {
  const requestId = input.requestId ?? crypto.randomUUID()
  return {
    kind: "permission", requestId,
    permission: {
      ...input.envelope, id: requestId, sessionID: input.sessionId, permission: input.permission,
      patterns: [...input.patterns ?? []], always: [...input.always ?? []],
      ...(input.title === undefined ? {} : { title: input.title }),
      metadata: input.metadata ? { ...input.metadata } : {},
      ...(input.harnessPayload === undefined ? {} : { harnessPayload: input.harnessPayload }),
    },
    ...(input.options === undefined ? {} : { options: input.options }),
    ...(input.grantKey === undefined ? {} : { grantKey: input.grantKey }),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
  }
}

type QuestionInput = {
  requestId?: string
  sessionId: string
  questions: AgentQuestion["questions"]
  harnessPayload?: unknown
  expiresAt?: number
}

export function questionRequest(input: QuestionInput): QuestionRequest {
  const requestId = input.requestId ?? crypto.randomUUID()
  return { kind: "question", requestId,
    question: { id: requestId, sessionID: input.sessionId, questions: input.questions,
      ...(input.harnessPayload === undefined ? {} : { harnessPayload: input.harnessPayload }) },
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }) }
}

export function elicitationRequest(input: Omit<ElicitationRequest, "kind" | "requestId"> & { requestId?: string }): ElicitationRequest {
  return { kind: "elicitation", requestId: input.requestId ?? crypto.randomUUID(), ...input }
}

export function permissionDecision(answer: RequestAnswer): PermissionDecision | undefined {
  return answer.kind === "permission" ? answer.decision : undefined
}

export function permissionSelection(answer: RequestAnswer): Extract<RequestAnswer, { kind: "permission" }> | undefined {
  return answer.kind === "permission" ? answer : undefined
}

export function requestQuestionAnswers(answer: RequestAnswer): Extract<RequestAnswer, { kind: "answers" }>["answers"] | undefined {
  return answer.kind === "answers" ? answer.answers : undefined
}

export function elicitationAnswer(answer: RequestAnswer):
  | { kind: "form"; values: Readonly<Record<string, unknown>> }
  | { kind: "consent"; accepted: boolean }
  | { kind: "decline" }
  | { kind: "cancel" } {
  if (answer.kind === "form") return answer
  if (answer.kind === "consent") return answer
  if (answer.kind === "rejected") return { kind: "decline" }
  return { kind: "cancel" }
}
