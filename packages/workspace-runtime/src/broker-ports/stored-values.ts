import type { AgentPermission, AgentQuestion, AgentSessionStartBinding } from "@claxedo/agent-runtime-contract"
import type { PermissionOptionKind, RequestAnswer, TurnRequest } from "@claxedo/harness/contract"
import { arr, bool, num, rec, str } from "../json-value"

function requiredBrokerRecord(value: unknown): Record<string, unknown> {
  const parsed = rec(value)
  if (!parsed) throw new Error("Invalid stored broker object")
  return parsed
}

function requiredBrokerString(value: unknown): string {
  const parsed = str(value)
  if (parsed === undefined) throw new Error("Invalid stored broker string")
  return parsed
}

function brokerStringList(value: unknown): string[] {
  const parsed = arr(value)
  if (!parsed || !parsed.every((item) => typeof item === "string")) throw new Error("Invalid stored broker strings")
  return parsed.filter((item): item is string => typeof item === "string")
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined
  const parsed = num(value)
  if (parsed === undefined) throw new Error("Invalid stored broker number")
  return parsed
}

function permission(value: unknown): AgentPermission {
  const row = requiredBrokerRecord(value)
  const options = row.options === undefined ? undefined : arr(row.options)?.map((item) => {
    const option = requiredBrokerRecord(item)
    return { id: requiredBrokerString(option.id), label: requiredBrokerString(option.label),
      ...(option.description === undefined ? {} : { description: requiredBrokerString(option.description) }) }
  })
  if (row.options !== undefined && !options) throw new Error("Invalid stored permission options")
  const tool = row.tool === undefined ? undefined : requiredBrokerRecord(row.tool)
  const time = row.time === undefined ? undefined : requiredBrokerRecord(row.time)
  return {
    id: requiredBrokerString(row.id), sessionID: requiredBrokerString(row.sessionID), permission: requiredBrokerString(row.permission),
    patterns: brokerStringList(row.patterns), always: brokerStringList(row.always), metadata: requiredBrokerRecord(row.metadata),
    ...(options === undefined ? {} : { options }),
    ...(tool === undefined ? {} : { tool: { messageID: requiredBrokerString(tool.messageID), callID: requiredBrokerString(tool.callID) } }),
    ...(time === undefined ? {} : { time: time.created === undefined ? {} : { created: optionalNumber(time.created) } }),
    ...(row.title === undefined ? {} : { title: requiredBrokerString(row.title) }),
    ...(row.harnessPayload === undefined ? {} : { harnessPayload: row.harnessPayload }),
  }
}

function storedBrokerQuestion(value: unknown): AgentQuestion {
  const row = requiredBrokerRecord(value)
  const questions = arr(row.questions)
  if (!questions) throw new Error("Invalid stored questions")
  const tool = row.tool === undefined ? undefined : requiredBrokerRecord(row.tool)
  return {
    id: requiredBrokerString(row.id), sessionID: requiredBrokerString(row.sessionID),
    questions: questions.map((item) => {
      const prompt = requiredBrokerRecord(item)
      const options = arr(prompt.options)
      if (!options) throw new Error("Invalid stored question options")
      return {
        header: requiredBrokerString(prompt.header), question: requiredBrokerString(prompt.question),
        options: options.map((option) => {
          const choice = requiredBrokerRecord(option)
          return { label: requiredBrokerString(choice.label), description: requiredBrokerString(choice.description) }
        }),
        ...(prompt.multiple === undefined ? {} : { multiple: bool(prompt.multiple) }),
        ...(prompt.custom === undefined ? {} : { custom: bool(prompt.custom) }),
      }
    }),
    ...(tool === undefined ? {} : { tool: { messageID: requiredBrokerString(tool.messageID), callID: requiredBrokerString(tool.callID) } }),
    ...(row.harnessPayload === undefined ? {} : { harnessPayload: row.harnessPayload }),
  }
}

export function parseStoredRequest(json: string): TurnRequest {
  const row = requiredBrokerRecord(JSON.parse(json))
  const common = { requestId: requiredBrokerString(row.requestId), ...(row.expiresAt === undefined ? {} : { expiresAt: optionalNumber(row.expiresAt) }) }
  if (row.kind === "permission") {
    const options = row.options === undefined ? undefined : arr(row.options)?.map((item) => {
      const option = requiredBrokerRecord(item)
      const kind = requiredBrokerString(option.kind)
      if (kind !== "allow_once" && kind !== "allow_always" && kind !== "reject_once" && kind !== "reject_always") {
        throw new Error("Invalid stored permission option kind")
      }
      const acceptedKind: PermissionOptionKind = kind
      return { optionId: requiredBrokerString(option.optionId), kind: acceptedKind, name: requiredBrokerString(option.name) }
    })
    if (row.options !== undefined && !options) throw new Error("Invalid stored request options")
    return { ...common, kind: "permission", permission: permission(row.permission),
      ...(options === undefined ? {} : { options }),
      ...(row.grantKey === undefined ? {} : { grantKey: requiredBrokerString(row.grantKey) }) }
  }
  if (row.kind === "question") return { ...common, kind: "question", question: storedBrokerQuestion(row.question) }
  if (row.kind === "elicitation") {
    if (row.mode !== "form" && row.mode !== "url") throw new Error("Invalid stored elicitation mode")
    return { ...common, kind: "elicitation", mode: row.mode, message: requiredBrokerString(row.message),
      ...(row.elicitationId === undefined ? {} : { elicitationId: requiredBrokerString(row.elicitationId) }),
      ...(row.schema === undefined ? {} : { schema: row.schema }),
      ...(row.url === undefined ? {} : { url: requiredBrokerString(row.url) }) }
  }
  throw new Error("Invalid stored broker request kind")
}

export function parseStoredAnswer(json: string): RequestAnswer {
  const row = requiredBrokerRecord(JSON.parse(json))
  if (row.kind === "permission") {
    const decision = requiredBrokerString(row.decision)
    if (decision !== "allow_once" && decision !== "allow_always" && decision !== "deny" && decision !== "reject_always") {
      throw new Error("Invalid stored permission decision")
    }
    return { kind: "permission", decision, ...(row.optionId === undefined ? {} : { optionId: requiredBrokerString(row.optionId) }) }
  }
  if (row.kind === "answers") {
    const answers = arr(row.answers)
    if (!answers) throw new Error("Invalid stored answers")
    return { kind: "answers", answers: answers.map(brokerStringList) }
  }
  if (row.kind === "form") return { kind: "form", values: requiredBrokerRecord(row.values) }
  if (row.kind === "consent") {
    const accepted = bool(row.accepted)
    if (accepted === undefined) throw new Error("Invalid stored consent")
    return { kind: "consent", accepted }
  }
  if (row.kind === "rejected" || row.kind === "cancelled" || row.kind === "expired") return { kind: row.kind }
  throw new Error("Invalid stored broker answer kind")
}

export function parseStoredStart(json: string): AgentSessionStartBinding {
  const row = requiredBrokerRecord(JSON.parse(json))
  return { sessionId: requiredBrokerString(row.sessionId), workspaceId: requiredBrokerString(row.workspaceId),
    directory: requiredBrokerString(row.directory), connectionId: requiredBrokerString(row.connectionId), operationId: requiredBrokerString(row.operationId) }
}

export function parseStoredPermissionState(json: string): Record<string, unknown> {
  return requiredBrokerRecord(JSON.parse(json))
}
