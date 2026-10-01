import { asRecord } from "@claxedo/helpers/guards"
import { asText as text } from "@claxedo/agent-runtime-contract"
import { optionLabels, pathFields } from "../../../translate/value"
import type { CodexHandler, CodexHandlers } from "./frame"
import { codexMcpApproval } from "./mcp-elicitation"
import { unmappedCodexAppServerEvent } from "./notices"

function requestTool(method: string, row: Record<string, unknown>) {
  return text(row.tool) ?? text(row.toolName) ?? (
    method.includes("fileRead")
      ? "file-read"
      : method.includes("fileChange") || method.includes("applyPatch")
        ? "file-change"
        : method.includes("command") || method.includes("execCommand")
          ? "command"
          : "tool"
  )
}

function optionDescriptions(options: unknown) {
  return Object.fromEntries((Array.isArray(options) ? options : []).flatMap((value) => {
    const option = asRecord(value)
    const label = text(option?.label)
    const description = text(option?.description)
    return label && description ? [[label, description]] : []
  }))
}

function questions(row: Record<string, unknown>) {
  const raw = Array.isArray(row.questions) ? row.questions : []
  return raw.flatMap((question, i) => {
    const item = asRecord(question)
    if (!item) return []
    const prompt = text(item.question) ?? text(item.prompt) ?? text(item.text)
    if (!prompt) return []
    const options = optionLabels(item.options)
    return [{
      text: prompt || `Question ${i + 1}`,
      header: text(item.header),
      optionDescriptions: optionDescriptions(item.options),
      ...(options.length ? { options } : {}),
    }]
  })
}

const approvalRequest: CodexHandler = ({ method, row, requestId, context }) => [{
  type: "permission-request",
  requestId: requestId ?? context.createId("request"),
  tool: requestTool(method, row),
  paths: pathFields(row, ["path", "filePath", "cwd"], ["paths", "scopes"]),
  details: { command: text(row.command), reason: text(row.reason) },
}]

export const requestHandlers: CodexHandlers = {
  "item/commandExecution/requestApproval": approvalRequest,
  "item/fileChange/requestApproval": approvalRequest,
  "item/permissions/requestApproval": approvalRequest,
  applyPatchApproval: approvalRequest,
  execCommandApproval: approvalRequest,
  "item/tool/call": approvalRequest,
  "item/tool/requestUserInput": ({ row, requestId, context }) => {
    const list = questions(row)
    if (list.length === 0) return []
    return [{ type: "question", requestId: requestId ?? context.createId("question"), questions: list }]
  },
  "mcpServer/elicitation/request": ({ row, requestId, context, event }) => {
    const consent = codexMcpApproval(row)
    if (!consent) return unmappedCodexAppServerEvent(event)
    return [{
      type: "permission-request",
      requestId: requestId ?? context.createId("request"),
      tool: consent.tool,
      paths: [],
      details: { reason: consent.reason },
      options: consent.options.map(({ id, label }) => ({ id, label })),
    }]
  },
}
