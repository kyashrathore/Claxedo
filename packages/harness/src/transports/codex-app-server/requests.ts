import { codexMcpApproval } from "./translate"
import { asRecordOrEmpty, asString } from "@claxedo/helpers/guards"
import { elicitationAnswer, elicitationRequest, permissionDecision, permissionRequest, permissionSelection, requestQuestionAnswers, questionRequest, type TurnBroker } from "../../contract"
import type { RpcMessage } from "./rpc"
import { CodexRequestRefusal, CodexTransportError } from "./errors"
import { grantIdentity } from "../../contract/grant-identity"

const approvalMethods = [
  "item/commandExecution/requestApproval", "item/fileChange/requestApproval",
  "item/permissions/requestApproval", "execCommandApproval", "applyPatchApproval",
] as const
const protocolDecisionMapping = {
  once: "allow_once", always: "allow_always", deny: "deny", never: "reject_always",
} as const
type RequestBroker = Pick<TurnBroker, "ask">

function decisionResponse(method: string, decision: string, params: Record<string, unknown>): unknown {
  const allow = decision === protocolDecisionMapping.once || decision === protocolDecisionMapping.always
  const session = decision === protocolDecisionMapping.always
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    return { decision: allow ? session ? "approved_for_session" : "approved" : decision === protocolDecisionMapping.deny ? "denied" : "abort" }
  }
  if (method === "item/permissions/requestApproval") return { permissions: allow ? asRecordOrEmpty(params.permissions) : {}, scope: session ? "session" : "turn" }
  return { decision: allow ? session ? "acceptForSession" : "accept" : decision === protocolDecisionMapping.deny ? "decline" : "cancel" }
}

async function approval(method: string, params: Record<string, unknown>, message: RpcMessage, broker: RequestBroker, sessionId: string,
  context?: { directory: string; permissionMode?: string }): Promise<unknown> {
  const command = typeof params.command === "string" ? params.command : JSON.stringify(params.changes ?? params.permissions ?? {})
  const { threadId: _threadId, turnId: _turnId, itemId: _itemId, startedAtMs: _startedAtMs, approvalId: _approvalId, ...keyParams } = params
  const answer = await broker.ask(permissionRequest({ sessionId, permission: method, title: command,
    patterns: [command], metadata: { method, params }, harnessPayload: message,
    grantKey: grantIdentity([method, context?.directory, context?.permissionMode, keyParams]),
    options: [
      { optionId: protocolDecisionMapping.once, kind: protocolDecisionMapping.once, name: "Allow once" },
      { optionId: protocolDecisionMapping.always, kind: protocolDecisionMapping.always, name: "Allow for session" },
      { optionId: protocolDecisionMapping.deny, kind: "reject_once", name: "Deny" },
    ],
  }))
  return decisionResponse(method, permissionDecision(answer) ?? protocolDecisionMapping.never, params)
}

async function question(params: Record<string, unknown>, message: RpcMessage, broker: RequestBroker, sessionId: string): Promise<unknown> {
  const rawQuestions: unknown[] = Array.isArray(params.questions) ? params.questions : []
  const questions = rawQuestions.map((value) => {
      const question = asRecordOrEmpty(value)
      return { header: asString(question.header) ?? "Question", question: asString(question.question) ?? "",
        options: (Array.isArray(question.options) ? question.options : []).map((option) => ({
          label: asString(asRecordOrEmpty(option).label) ?? "", description: asString(asRecordOrEmpty(option).description) ?? "",
        })), custom: question.isOther === true }
  })
  const answers = requestQuestionAnswers(await broker.ask(questionRequest({ sessionId, questions, harnessPayload: message })))
  if (!answers) return { answers: {} }
  const ids = rawQuestions.map((item) => asString(asRecordOrEmpty(item).id) ?? "answer")
  return { answers: Object.fromEntries(ids.map((id, index) => [id, { answers: answers[index] ?? [] }])) }
}

async function elicitation(params: Record<string, unknown>, message: RpcMessage, broker: RequestBroker, sessionId: string): Promise<unknown> {
    const approval = codexMcpApproval(params)
    if (approval) {
      const answer = await broker.ask(permissionRequest({ sessionId, permission: "mcp", title: approval.reason,
        patterns: [approval.tool], metadata: { method: message.method, params }, harnessPayload: message,
        envelope: { options: approval.options.map((option) => ({ id: option.id, label: option.label })) },
        options: approval.options.map((option) => ({ optionId: option.id,
          kind: option.id.startsWith("{") ? protocolDecisionMapping.always : option.id === "accept" ? protocolDecisionMapping.once : "reject_once" as const,
          name: option.label })),
      }))
      const selectedId = permissionSelection(answer)?.optionId
      const selected = approval.options.find((option) => option.id === selectedId)
      return selected?.response ?? { action: "cancel" }
    }
    const answer = elicitationAnswer(await broker.ask(elicitationRequest({ mode: params.mode === "url" ? "url" : "form",
      message: asString(params.message) ?? "", ...(params.mode === "url" ? { url: asString(params.url) ?? "", elicitationId: asString(params.elicitationId) ?? "" } : { schema: params.requestedSchema }) })))
    if (answer.kind === "form") return { action: "accept", content: answer.values }
    if (answer.kind === "consent" && answer.accepted) return { action: "accept", content: null }
    if (answer.kind === "decline") return { action: "decline", content: null }
    return { action: "cancel" }
}

export function isCodexRequestMethod(method: string): boolean {
  return approvalMethods.some((name) => name === method) || method === "item/tool/requestUserInput" || method === "mcpServer/elicitation/request"
}

export async function answerCodexRequest(message: RpcMessage, broker: RequestBroker, sessionId: string,
  context?: { directory: string; permissionMode?: string }): Promise<unknown> {
  const { method } = message
  if (!method) throw new CodexTransportError("protocol", "Codex request has no method")
  const params = asRecordOrEmpty(message.params)
  if (approvalMethods.some((name) => name === method)) return approval(method, params, message, broker, sessionId, context)
  if (method === "item/tool/requestUserInput") return question(params, message, broker, sessionId)
  if (method === "mcpServer/elicitation/request") return elicitation(params, message, broker, sessionId)
  throw new CodexRequestRefusal(-32601, `Unsupported Codex request ${method}`)
}
