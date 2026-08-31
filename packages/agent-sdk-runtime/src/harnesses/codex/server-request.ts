import { randomUUID } from "crypto"
import type { JsonRecord, SdkRuntimeDriverHost } from "../shared/sdk-runtime-driver"
import { record, text } from "../shared/sdk-runtime-values"
import type { CodexActiveThread } from "./active-thread"
import { spawnDynamicCodexAgent } from "./dynamic-agent"

type RefreshedTokens = { access: string; accountId: string; planType?: string }

export async function handleCodexServerRequest(input: {
  message: JsonRecord
  activeThreads: Map<string, CodexActiveThread>
  host: SdkRuntimeDriverHost
  permissionModeId(sessionId: string): string | undefined
  refreshTokens(): Promise<RefreshedTokens>
}) {
  const method = text(input.message.method) ?? "request"
  const params = record(input.message.params) ?? {}
  const requestId = String(input.message.id ?? randomUUID())
  const threadId = text(params.threadId) ?? text(params.conversationId)
  const active = threadId ? input.activeThreads.get(threadId) : undefined
  const payload = { ...params, requestId }

  if (method === "item/tool/requestUserInput") {
    active?.project(method, payload, input.message)
    const questions = Array.isArray(params.questions) ? params.questions : []
    const answer = await new Promise<string>((resolve, reject) => {
      if (!active) {
        reject(new Error("No active session for Codex question"))
        return
      }
      input.host.pendingQuestions.set(requestId, {
        sessionId: active.sessionId,
        agentSessionId: active.agentSessionId,
        questions,
        resolve,
        reject,
      })
    })
    const ids = questionIds(params)
    return { answers: Object.fromEntries((ids[0] ? ids : ["answer"]).map((id) => [id, { answers: [answer] }])) }
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
    active?.project(method, payload, input.message)
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
    })
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
  return list.flatMap((question) => text(record(question)?.id) ?? [])
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
      permissions: allow ? (record(params.permissions) ?? {}) : {},
      scope: session ? "session" : "turn",
    }
  }
  return { decision: allow ? session ? "acceptForSession" : "accept" : decision === "deny" ? "decline" : "cancel" }
}
