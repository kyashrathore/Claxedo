import { asArray, asRecordOrEmpty } from "@claxedo/helpers/guards"
import type { AgentQuestionAnswer } from "@claxedo/agent-runtime-contract"
import type { TurnBroker } from "../../contract"
import type { ProjectedEvent } from "./event-pump"
import type { OpenCodeRuntime } from "./runtime"
import type { WorkspaceScope } from "./scope"
import type { FormFieldValue } from "./interaction-port"
import { OpenCodeTransportError } from "./errors.js"

const protocolPermissionMapping = {
  options: [
    { optionId: "once", kind: "allow_once", name: "Allow once" },
    { optionId: "always", kind: "allow_always", name: "Always allow" },
    { optionId: "reject", kind: "reject_once", name: "Deny" },
  ],
  replies: { allow_once: "once", allow_always: "always", deny: "reject", reject_always: "reject" },
} as const

function fieldQuestion(field: unknown) {
  const row = asRecordOrEmpty(field)
  const key = typeof row.key === "string" ? row.key : "answer"
  const options = asArray(row.options).map((option) => {
    const item = asRecordOrEmpty(option)
    return { label: typeof item.label === "string" ? item.label : typeof item.value === "string" ? item.value : "",
      description: typeof item.description === "string" ? item.description : "" }
  })
  return { header: typeof row.title === "string" ? row.title : key,
    question: typeof row.description === "string" ? row.description : typeof row.title === "string" ? row.title : key,
    options, ...(row.type === "multiselect" ? { multiple: true } : {}),
    ...(options.length === 0 || row.custom === true ? { custom: true } : {}) }
}

function formValue(field: unknown, answer: AgentQuestionAnswer | undefined): FormFieldValue {
  const row = asRecordOrEmpty(field)
  const options = asArray(row.options).map(asRecordOrEmpty)
  const selected = (answer ?? []).map((label) => {
    const option = options.find((candidate) => candidate.label === label)
    return typeof option?.value === "string" ? option.value : label
  })
  if (row.type === "multiselect") return selected
  const value = selected[0] ?? ""
  if (row.type === "number" || row.type === "integer") {
    const number = Number(value)
    if (!Number.isFinite(number) || (row.type === "integer" && !Number.isInteger(number))) {
      throw new OpenCodeTransportError("request", `OpenCode form field ${String(row.key)} requires a number`)
    }
    return number
  }
  if (row.type === "boolean") {
    if (value !== "true" && value !== "false") throw new OpenCodeTransportError("request", `OpenCode form field ${String(row.key)} requires a boolean`)
    return value === "true"
  }
  return value
}

async function permission(event: ProjectedEvent, runtime: OpenCodeRuntime, scope: WorkspaceScope, broker: TurnBroker,
  claxedoSessionID: string): Promise<void> {
  const row = asRecordOrEmpty(event.data)
  const id = typeof row.id === "string" ? row.id : ""
  const sessionID = typeof row.sessionID === "string" ? row.sessionID : ""
  if (!id || !sessionID) throw new OpenCodeTransportError("request", "OpenCode permission request has no identity")
  const action = typeof row.action === "string" ? row.action : "unknown"
  const resources = asArray(row.resources).filter((item): item is string => typeof item === "string")
  const metadata = asRecordOrEmpty(row.metadata)
  const answer = await broker.ask({ kind: "permission", requestId: id,
    grantKey: JSON.stringify([action, resources, scope.directory]),
    permission: { id, sessionID: claxedoSessionID, permission: action, patterns: resources,
      always: asArray(row.save).filter((item): item is string => typeof item === "string"), metadata,
      ...(typeof row.message === "string" ? { title: row.message } : {}) },
    options: protocolPermissionMapping.options,
  })
  const reply = answer.kind === "permission" ? protocolPermissionMapping.replies[answer.decision] : "reject"
  await runtime.interactions.replyPermission(scope, { sessionID, requestID: id, reply })
}

async function form(event: ProjectedEvent, runtime: OpenCodeRuntime, scope: WorkspaceScope, broker: TurnBroker,
  claxedoSessionID: string): Promise<void> {
  const row = asRecordOrEmpty(asRecordOrEmpty(event.data).form)
  const id = typeof row.id === "string" ? row.id : ""
  const sessionID = typeof row.sessionID === "string" ? row.sessionID : ""
  if (!id || !sessionID) throw new OpenCodeTransportError("request", "OpenCode form request has no identity")
  const fields = asArray(row.fields)
  const answer = await broker.ask({ kind: "question", requestId: id,
    question: { id, sessionID: claxedoSessionID, questions: fields.map(fieldQuestion) },
  })
  if (answer.kind !== "answers") {
    await runtime.interactions.cancelForm(scope, { sessionID, formID: id })
    return
  }
  const values: Record<string, FormFieldValue> = {}
  fields.forEach((field, index) => {
    const key = asRecordOrEmpty(field).key
    if (typeof key !== "string") throw new OpenCodeTransportError("request", "OpenCode form field has no key")
    values[key] = formValue(field, answer.answers[index])
  })
  await runtime.interactions.replyForm(scope, { sessionID, formID: id, answer: values })
}

export async function answerOpenCodeRequest(event: ProjectedEvent, runtime: OpenCodeRuntime, scope: WorkspaceScope,
  broker: TurnBroker, claxedoSessionID: string): Promise<boolean> {
  if (event.type === "permission.asked") { await permission(event, runtime, scope, broker, claxedoSessionID); return true }
  if (event.type === "form.created") { await form(event, runtime, scope, broker, claxedoSessionID); return true }
  return false
}
