import { randomUUID } from "crypto"
import type { AgentQuestionAnswer } from "@claxedo/agent-runtime-contract"
import { codexMcpApproval } from "@claxedo/agent-event-runtime/harnesses/codex"
import type { JsonRecord, SdkRuntimeDriverHost } from "../shared/sdk-runtime-driver"
import { asRecord } from "@claxedo/helpers/guards"
import { text } from "../shared/sdk-runtime-values"
import type { CodexActiveThread } from "./active-thread"
import { spawnDynamicCodexAgent } from "./dynamic-agent"
import { mcpElicitationQuestion, mcpElicitationResponse } from "../shared/mcp-elicitation"
import { codexCommandGrant, hasCodexCommandGrant, saveCodexCommandGrant } from "./permission-state"

/** A refreshed ChatGPT credential, in the app-server's own field names below. */
type RefreshedTokens = { access: string; accountId?: string; planType?: string }

export async function handleCodexServerRequest(input: {
  message: JsonRecord
  activeThreads: Map<string, CodexActiveThread>
  host: SdkRuntimeDriverHost
  permissionModeId(sessionId: string): string | undefined
  refreshTokens(): Promise<RefreshedTokens>
}) {
  const method = text(input.message.method) ?? "request"
  const params = asRecord(input.message.params) ?? {}
  // RPC IDs are process-local and restart at zero. Allocate an app interaction
  // ID here; the process transport still replies using the original frame ID.
  const requestId = randomUUID()
  const threadId = text(params.threadId) ?? text(params.conversationId)
  const active = threadId ? input.activeThreads.get(threadId) : undefined
  const payload = { ...params, requestId }

  if (method === "item/tool/requestUserInput") {
    const questions = Array.isArray(params.questions) ? params.questions : []
    const answers = await new Promise<AgentQuestionAnswer[] | undefined>((resolve, reject) => {
      if (!active) {
        reject(new Error("No active session for Codex question"))
        return
      }
      input.host.pendingQuestions.set(requestId, {
        sessionId: active.sessionId,
        agentSessionId: active.agentSessionId,
        questions,
        resolve,
        reject: () => resolve(undefined),
      })
      active.project(method, payload, input.message)
    }).finally(() => input.host.pendingQuestions.delete(requestId))
    if (!answers) return { answers: {} }
    const ids = questionIds(params)
    return {
      answers: Object.fromEntries(
        (ids[0] ? ids : ["answer"]).map((id, index) => [id, { answers: answers[index] ?? [] }]),
      ),
    }
  }

  // Consent uses permissions; URL authorization and forms use questions.
  if (method === "mcpServer/elicitation/request") {
    if (!active) return { action: "cancel" }

    const approval = codexMcpApproval(params)
    if (approval) {
      const optionId = await new Promise<string | undefined>((resolve) => {
        input.host.pendingPermissions.set(requestId, {
          sessionId: active.sessionId,
          agentSessionId: active.agentSessionId,
          method,
          params,
          resolve: (_decision, optionId) => resolve(optionId),
        })
        active.project(method, payload, input.message)
      }).finally(() => input.host.pendingPermissions.delete(requestId))
      // The interaction owner validates offered IDs before resolving the request.
      // Cancellation from turn teardown has no selected option.
      if (optionId === undefined) return { action: "cancel" }
      const selected = approval.options.find((option) => option.id === optionId)
      if (!selected) throw new Error("MCP approval option was not offered")
      return selected.response
    }

    const question = mcpElicitationQuestion(params)
    const answers = await new Promise<AgentQuestionAnswer[] | undefined>((resolve) => {
      input.host.pendingQuestions.set(requestId, {
        sessionId: active.sessionId,
        agentSessionId: active.agentSessionId,
        questions: [question],
        resolve,
        reject: () => resolve(undefined),
      })
      active.project("item/tool/requestUserInput", { ...params, requestId, questions: [question] }, input.message)
    }).finally(() => input.host.pendingQuestions.delete(requestId))
    // One projected question, so its first selected answer is the elicitation result.
    return mcpElicitationResponse(params, answers?.[0]?.[0])
  }

  if (method === "item/tool/call") {
    if (!active || text(params.tool) !== "spawn_agent") {
      return {
        contentItems: [{ type: "inputText", text: `Dynamic tool ${text(params.tool) ?? "call"} is not implemented by Claxedo.` }],
        success: false,
      }
    }
    return spawnDynamicCodexAgent({
      active,
      params,
      frame: input.message,
      permissionModeId: input.permissionModeId(active.sessionId),
    })
  }

  if (APPROVAL_METHODS.has(method)) {
    const grant = active && codexCommandGrant(method, params, active.directory, input.permissionModeId(active.sessionId))
    if (active && grant && hasCodexCommandGrant(input.host, active.sessionId, grant)) {
      return permissionResponse(method, "allow_always", params)
    }
    const decision = await new Promise<"allow_once" | "allow_always" | "deny" | "reject_always">((resolve) => {
      if (!active) {
        resolve("deny")
        return
      }
      input.host.pendingPermissions.set(requestId, {
        sessionId: active.sessionId,
        agentSessionId: active.agentSessionId,
        method,
        params,
        resolve,
      })
      active.project(method, payload, input.message)
    }).finally(() => input.host.pendingPermissions.delete(requestId))
    if (active && grant && decision === "allow_always") saveCodexCommandGrant(input.host, active.sessionId, grant)
    return permissionResponse(method, decision, params)
  }

  if (method === "account/chatgptAuthTokens/refresh") {
    const tokens = await input.refreshTokens()
    return {
      accessToken: tokens.access,
      chatgptAccountId: tokens.accountId,
      chatgptPlanType: tokens.planType ?? null,
    }
  }
  throw new Error(`Unsupported Codex app-server request: ${method}`)
}

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "applyPatchApproval",
  "execCommandApproval",
])

function questionIds(params: JsonRecord) {
  const list = Array.isArray(params.questions) ? params.questions : []
  return list.flatMap((question) => text(asRecord(question)?.id) ?? [])
}

function permissionResponse(
  method: string,
  decision: "allow_once" | "allow_always" | "deny" | "reject_always",
  params: JsonRecord,
) {
  const allow = decision === "allow_once" || decision === "allow_always"
  const session = decision === "allow_always"
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    return { decision: allow ? session ? "approved_for_session" : "approved" : decision === "deny" ? "denied" : "abort" }
  }
  if (method === "item/permissions/requestApproval") {
    return {
      permissions: allow ? (asRecord(params.permissions) ?? {}) : {},
      scope: session ? "session" : "turn",
    }
  }
  return { decision: allow ? session ? "acceptForSession" : "accept" : decision === "deny" ? "decline" : "cancel" }
}
