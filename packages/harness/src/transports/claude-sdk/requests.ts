import { claudeModeId } from "./permissions"
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk"
import { permissionDecision, permissionRequest, requestQuestionAnswers, questionRequest, type StartInput, type TurnBroker } from "../../contract"
import { TransportError } from "../../contract/errors"
import { claudeGrant } from "./grants"

const protocolPermissionMap = {
  allowOnce: "allow_once", allowAlways: "allow_always", rejectAlways: "reject_always", allow: "allow", deny: "deny",
  options: [
    { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
    { optionId: "allow_always", kind: "allow_always", name: "Always allow" },
    { optionId: "deny", kind: "reject_once", name: "Deny" },
    { optionId: "reject_always", kind: "reject_always", name: "Reject and stop" },
  ],
} as const

export async function askClaudePermission(input: StartInput, broker: TurnBroker, toolName: string,
  toolInput: Record<string, unknown>, options: Parameters<CanUseTool>[2], turnId?: string) {
  if (options.signal.aborted || broker.signal.aborted) return { behavior: protocolPermissionMap.deny, message: "Turn cancelled" }
  if (toolName === "AskUserQuestion") {
    const questions = toolInput.questions
    if (!Array.isArray(questions) || !questions.length || questions.some((question) =>
      !question || typeof question !== "object" || typeof question.question !== "string" || !question.question.trim())) {
      throw new TransportError("claude", "protocol", "Claude question requires non-empty question text")
    }
    const answers = requestQuestionAnswers(await broker.ask(questionRequest({ sessionId: input.sessionId, questions,
      harnessPayload: { toolName, toolInput } }), { signal: options.signal }))
    if (!answers) return { behavior: protocolPermissionMap.deny, message: "Question dismissed" }
    if (answers.length !== questions.length) throw new TransportError("claude", "protocol", "Claude question reply must answer each question")
    return { behavior: protocolPermissionMap.allow, updatedInput: { ...toolInput,
      answers: Object.fromEntries(answers.map((value, index) => [questions[index]?.question, value.join(", ")])) } }
  }
  const grant = claudeGrant({ directory: input.directory, permissionMode: claudeModeId(input.config.permissionMode) }, toolName, toolInput, options)
  const answer = await broker.ask(permissionRequest({ sessionId: input.sessionId, permission: toolName, title: options.title ?? toolName,
    ...(grant ? { grantKey: grant.key } : {}), metadata: { input: toolInput, description: options.description ?? "", turnId },
    harnessPayload: { toolName, toolInput, suggestions: options.suggestions },
    options: protocolPermissionMap.options,
  }), { signal: options.signal })
  if (options.signal.aborted || broker.signal.aborted) return { behavior: protocolPermissionMap.deny, message: "Turn cancelled" }
  const decision = permissionDecision(answer)
  if (!decision) return { behavior: protocolPermissionMap.deny, message: "Permission dismissed" }
  if (decision === protocolPermissionMap.allowOnce) return { behavior: protocolPermissionMap.allow, updatedInput: toolInput }
  if (decision === protocolPermissionMap.allowAlways) {
    return { behavior: protocolPermissionMap.allow, updatedInput: toolInput, ...(grant?.updates ? { updatedPermissions: grant.updates } : {}) }
  }
  return { behavior: protocolPermissionMap.deny, message: "Permission denied", interrupt: decision === protocolPermissionMap.rejectAlways }
}
