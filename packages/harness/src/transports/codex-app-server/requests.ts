import { randomUUID } from "node:crypto"
import { codexMcpApproval } from "@claxedo/agent-event-runtime/harnesses/codex"
import { asRecordOrEmpty, asString } from "@claxedo/helpers/guards"
import type { TurnBroker } from "../../contract"
import type { RpcMessage } from "./rpc"
import { CodexTransportError } from "./errors"

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

async function approval(method: string, params: Record<string, unknown>, message: RpcMessage, broker: RequestBroker, sessionId: string): Promise<unknown> {
  const requestId = randomUUID()
  const command = typeof params.command === "string" ? params.command : JSON.stringify(params.changes ?? params.permissions ?? {})
  const { threadId: _threadId, turnId: _turnId, itemId: _itemId, startedAtMs: _startedAtMs, approvalId: _approvalId, ...keyParams } = params
  const answer = await broker.ask({ kind: "permission", requestId,
    permission: { id: requestId, sessionID: sessionId, permission: method, title: command,
      patterns: [command], always: [], metadata: { method, params }, harnessPayload: message },
    grantKey: JSON.stringify([method, keyParams]),
    options: [
      { optionId: protocolDecisionMapping.once, kind: protocolDecisionMapping.once, name: "Allow once" },
      { optionId: protocolDecisionMapping.always, kind: protocolDecisionMapping.always, name: "Allow for session" },
      { optionId: protocolDecisionMapping.deny, kind: "reject_once", name: "Deny" },
    ],
  })
  return decisionResponse(method, answer.kind === "permission" ? answer.decision : protocolDecisionMapping.never, params)
}

async function question(params: Record<string, unknown>, message: RpcMessage, broker: RequestBroker, sessionId: string): Promise<unknown> {
  const requestId = randomUUID()
  const rawQuestions: unknown[] = Array.isArray(params.questions) ? params.questions : []
  const questions = rawQuestions.map((value) => {
      const question = asRecordOrEmpty(value)
      return { header: asString(question.header) ?? "Question", question: asString(question.question) ?? "",
        options: (Array.isArray(question.options) ? question.options : []).map((option) => ({
          label: asString(asRecordOrEmpty(option).label) ?? "", description: asString(asRecordOrEmpty(option).description) ?? "",
        })), custom: question.isOther === true }
  })
  const answer = await broker.ask({ kind: "question", requestId,
    question: { id: requestId, sessionID: sessionId, questions, harnessPayload: message } })
  const ids = rawQuestions.map((item) => asString(asRecordOrEmpty(item).id) ?? "answer")
  return { answers: Object.fromEntries(ids.map((id, index) => [id, { answers: answer.kind === "answers" ? answer.answers[index] ?? [] : [] }])) }
}

async function elicitation(params: Record<string, unknown>, message: RpcMessage, broker: RequestBroker, sessionId: string): Promise<unknown> {
  const requestId = randomUUID()
    const approval = codexMcpApproval(params)
    if (approval) {
      const answer = await broker.ask({ kind: "permission", requestId,
        permission: { id: requestId, sessionID: sessionId, permission: "mcp", title: approval.reason,
          patterns: [approval.tool], always: [], metadata: { method: message.method, params }, harnessPayload: message,
          options: approval.options.map((option) => ({ id: option.id, label: option.label })) },
        options: approval.options.map((option) => ({ optionId: option.id,
          kind: option.id.startsWith("{") ? protocolDecisionMapping.always : option.id === "accept" ? protocolDecisionMapping.once : "reject_once" as const,
          name: option.label })),
      })
      const selected = answer.kind === "permission" ? approval.options.find((option) => option.id === answer.optionId) : undefined
      return selected?.response ?? { action: "cancel" }
    }
    const answer = await broker.ask({ kind: "elicitation", requestId, mode: params.mode === "url" ? "url" : "form",
      message: asString(params.message) ?? "", ...(params.mode === "url" ? { url: asString(params.url) ?? "", elicitationId: asString(params.elicitationId) ?? "" } : { schema: params.requestedSchema }) })
    if (answer.kind === "form") return { action: "accept", content: answer.values }
    if (answer.kind === "consent" && answer.accepted) return { action: "accept", content: null }
    return { action: "cancel" }
}

export async function answerCodexRequest(message: RpcMessage, broker: RequestBroker, sessionId: string): Promise<unknown> {
  const { method } = message
  if (!method) throw new CodexTransportError("protocol", "Codex request has no method")
  const params = asRecordOrEmpty(message.params)
  if (approvalMethods.some((name) => name === method)) return approval(method, params, message, broker, sessionId)
  if (method === "item/tool/requestUserInput") return question(params, message, broker, sessionId)
  if (method === "mcpServer/elicitation/request") return elicitation(params, message, broker, sessionId)
  throw new CodexTransportError("protocol", `Unsupported Codex request ${method}`)
}
