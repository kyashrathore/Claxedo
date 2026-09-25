import { randomUUID } from "node:crypto"
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk"
import type { StartInput, TurnBroker } from "../../contract"
import { ClaudeTransportError } from "./errors"

const protocolPermissionMap = {
  allowOnce: "allow_once", allowAlways: "allow_always", rejectAlways: "reject_always", allow: "allow", deny: "deny",
  options: [
    { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
    { optionId: "allow_always", kind: "allow_always", name: "Always allow" },
    { optionId: "deny", kind: "reject_once", name: "Deny" },
  ],
} as const

export async function askClaudePermission(input: StartInput, broker: TurnBroker, toolName: string,
  toolInput: Record<string, unknown>, options: Parameters<CanUseTool>[2], turnId?: string) {
  if (options.signal.aborted || broker.signal.aborted) return { behavior: protocolPermissionMap.deny, message: "Turn cancelled" }
  const requestId = randomUUID()
  if (toolName === "AskUserQuestion") {
    const questions = toolInput.questions
    if (!Array.isArray(questions) || !questions.length) throw new ClaudeTransportError("protocol", "Claude question has no choices")
    const answer = await broker.ask({ kind: "question", requestId, question: {
      id: requestId, sessionID: input.sessionId, questions, harnessPayload: { toolName, toolInput },
    } }, { signal: options.signal })
    if (answer.kind !== "answers") return { behavior: protocolPermissionMap.deny, message: "Question dismissed" }
    return { behavior: protocolPermissionMap.allow, updatedInput: { ...toolInput,
      answers: Object.fromEntries(answer.answers.map((value, index) => [questions[index]?.question, value.join(", ")])) } }
  }
  const answer = await broker.ask({ kind: "permission", requestId,
    grantKey: JSON.stringify({ toolName, toolInput, directory: input.directory, mode: input.config.permissionMode,
      blockedPath: options.blockedPath, agentID: options.agentID, description: options.description,
      title: options.title, suggestions: options.suggestions }),
    permission: { id: requestId, sessionID: input.sessionId, permission: toolName, title: options.title ?? toolName,
      patterns: [], always: [], metadata: { input: toolInput, description: options.description ?? "", turnId },
      harnessPayload: { toolName, toolInput, suggestions: options.suggestions } },
    options: protocolPermissionMap.options,
  }, { signal: options.signal })
  if (options.signal.aborted || broker.signal.aborted) return { behavior: protocolPermissionMap.deny, message: "Turn cancelled" }
  if (answer.kind !== "permission") return { behavior: protocolPermissionMap.deny, message: "Permission dismissed" }
  if (answer.decision === protocolPermissionMap.allowOnce || answer.decision === protocolPermissionMap.allowAlways) {
    return { behavior: protocolPermissionMap.allow, updatedInput: toolInput }
  }
  return { behavior: protocolPermissionMap.deny, message: "Permission denied", interrupt: answer.decision === protocolPermissionMap.rejectAlways }
}
