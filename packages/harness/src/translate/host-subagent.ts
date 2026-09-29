import { asRecord } from "@claxedo/helpers/guards"
import type { SubagentStatus } from "@claxedo/agent-runtime-contract"
import { text } from "./value"

export const HOST_SUBAGENT_MCP_SERVER = "claxedo"
export const HOST_SUBAGENT_TOOL = "create_subagent"
export const HOST_SUBAGENT_RESULT_KIND = "claxedo.subagent"

export function isHostSubagentTool(toolName: string, server?: string) {
  const normalized = toolName.toLowerCase()
  if (normalized === `mcp__${HOST_SUBAGENT_MCP_SERVER}__${HOST_SUBAGENT_TOOL}`) return true
  return normalized === HOST_SUBAGENT_TOOL && (server === undefined || server.toLowerCase() === HOST_SUBAGENT_MCP_SERVER)
}

export type HostSubagentBinding = {
  subagentKey: string
  sessionId: string
  status?: SubagentStatus
  summary?: string
}

export function hostSubagentBinding(result: unknown): HostSubagentBinding | undefined {
  for (const candidate of candidates(result)) {
    const row = asRecord(candidate)
    if (row?.kind !== HOST_SUBAGENT_RESULT_KIND) continue
    const subagentKey = text(row.subagentKey)
    const sessionId = text(row.sessionId)
    if (!subagentKey || !sessionId) continue
    const status = hostBindingStatus(row.status)
    const summary = text(row.summary)
    return {
      subagentKey,
      sessionId,
      ...(status ? { status } : {}),
      ...(summary ? { summary } : {}),
    }
  }
  return undefined
}

function* candidates(value: unknown): Generator {
  if (typeof value === "string") {
    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch {
      return
    }
    yield* candidates(parsed)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) yield* candidates(item)
    return
  }
  const row = asRecord(value)
  if (!row) return
  yield row
  if (row.structuredContent !== undefined) yield* candidates(row.structuredContent)
  if (row.content !== undefined) yield* candidates(row.content)
  if (row.value !== undefined) yield* candidates(row.value)
  if (row.type === "text" && typeof row.text === "string") yield* candidates(row.text)
}

const STATUSES: readonly SubagentStatus[] = ["pending", "running", "paused", "interrupted", "completed", "failed", "killed"]

function hostBindingStatus(value: unknown): SubagentStatus | undefined {
  return STATUSES.find((status) => status === value)
}

export type HostSubagentObservation = {
  observationId: string
  harnessExecutionId?: string
  subagentKey: string
  toolCallId: string
  status?: SubagentStatus
  providerId: string
  providerKind: "claxedo"
  childSessionId: string
  transcript: { kind: "live" }
}

export function hostSubagentObservation(input: {
  observationId: string
  harnessExecutionId?: string
  toolCallId: string
  binding: HostSubagentBinding
}): HostSubagentObservation {
  return {
    observationId: input.observationId,
    ...(input.harnessExecutionId ? { harnessExecutionId: input.harnessExecutionId } : {}),
    subagentKey: input.binding.subagentKey,
    toolCallId: input.toolCallId,
    ...(input.binding.status ? { status: input.binding.status } : {}),
    providerId: input.binding.sessionId,
    providerKind: "claxedo",
    childSessionId: input.binding.sessionId,
    transcript: { kind: "live" },
  }
}
