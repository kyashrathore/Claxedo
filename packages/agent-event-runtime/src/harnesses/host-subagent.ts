import { asRecord } from "@claxedo/helpers/guards"
import type { SubagentStatus, SubagentToolCallRole } from "../contracts/agent-runtime-event"
import { text } from "../value"

export const HOST_SUBAGENT_MCP_SERVER = "claxedo"
export const HOST_SUBAGENT_TOOL = "create_subagent"
export const HOST_SUBAGENT_RESULT_KIND = "claxedo.subagent"

/**
 * Whether a tool call is the runtime's own `create_subagent`, in whichever
 * wrapping the harness reports MCP tools: Claude prefixes `mcp__<server>__`,
 * Codex and Cursor carry the server beside the bare name.
 */
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

/**
 * The child binding carried by a `create_subagent` tool result. The tool
 * answers with JSON `{ kind: "claxedo.subagent", subagentKey, sessionId,
 * status?, summary? }`; MCP hosts deliver it as text content blocks, as
 * `structuredContent`, or already parsed, so every wrapping is unwrapped here.
 * The `kind` marker is what makes the shape self-identifying: a result is only
 * a binding when it says so.
 */
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

function* candidates(value: unknown): Generator<unknown> {
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
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value) ? value as SubagentStatus : undefined
}

export type HostSubagentObservation = {
  observationId: string
  harnessExecutionId?: string
  subagentKey: string
  toolCallId: string
  toolCallRole: SubagentToolCallRole
  status?: SubagentStatus
  providerId: string
  providerKind: "claxedo"
  childSessionId: string
  transcript: { kind: "live" }
}

/**
 * The observation a bound `create_subagent` result raises on the parent, the
 * same on every harness: it names the host-minted row and binds the tool call
 * to it as the spawn edge. The row exists only once the runtime has minted
 * the key, so the call itself raises nothing until its result arrives.
 */
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
    toolCallRole: "spawn",
    ...(input.binding.status ? { status: input.binding.status } : {}),
    providerId: input.binding.sessionId,
    providerKind: "claxedo",
    childSessionId: input.binding.sessionId,
    transcript: { kind: "live" },
  }
}
