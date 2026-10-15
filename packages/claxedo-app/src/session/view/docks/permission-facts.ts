import type { AgentPermission } from "@claxedo/agent-runtime-contract"
import { isRecord } from "@claxedo/helpers/guards"

const INPUT_SUMMARY_FIELDS = ["file_path", "notebook_path", "path", "url", "pattern", "query"] as const

export type PermissionInputField = { readonly name: string; readonly value: string }

export type PermissionFacts = {
  readonly tool: string
  readonly command?: string
  readonly reason?: string
  readonly directory?: string
  readonly inputFields: readonly PermissionInputField[]
  readonly agentText: readonly string[]
  readonly details?: string
}

function record(value: unknown) {
  return isRecord(value) ? value : undefined
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined
}

function agentText(tool: Record<string, unknown> | undefined) {
  const content = Array.isArray(tool?.content) ? tool.content : []
  return content.flatMap((item) => {
    const block = record(item)
    const value = record(block?.content)
    return block?.type === "content" && value?.type === "text" && typeof value.text === "string" ? [value.text] : []
  })
}

function inputFields(input: Record<string, unknown> | undefined): PermissionInputField[] {
  return INPUT_SUMMARY_FIELDS.flatMap((name) => {
    const value = text(input?.[name])
    return value ? [{ name, value }] : []
  })
}

function details(toolCall: Record<string, unknown> | undefined, meta: Record<string, unknown> | undefined,
  input: Record<string, unknown> | undefined) {
  if (toolCall || meta) return JSON.stringify({ toolCall, request: meta }, null, 2)
  return input && Object.keys(input).length > 0 ? JSON.stringify(input, null, 2) : undefined
}

export function permissionFacts(request: AgentPermission): PermissionFacts {
  const toolCall = record(request.metadata.acpToolCall)
  const meta = record(request.metadata.acpRequestMeta)
  const permission = record(meta?.permission)
  const input = record(request.metadata.input)
  const described = permission?.version === 1 ? text(permission.description) : undefined
  const command = text(request.metadata.command) ?? text(input?.command)
  const reason = described ?? text(request.metadata.reason) ?? text(request.metadata.description)
  const directory = text(record(toolCall?.rawInput)?.cwd)
  const shown = details(toolCall, meta, input)
  return {
    tool: request.permission,
    ...(command ? { command } : {}),
    ...(reason ? { reason } : {}),
    ...(directory ? { directory } : {}),
    inputFields: inputFields(input),
    agentText: agentText(toolCall),
    ...(shown ? { details: shown } : {}),
  }
}
