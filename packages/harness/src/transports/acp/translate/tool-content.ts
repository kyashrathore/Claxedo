import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { boundList } from "../../../translate/value"
import type { ToolCallContent } from "@agentclientprotocol/sdk"
import { diffKey, pathKey, RETAINED_TOOL_ITEMS_MAX, type Spot, type ToolState } from "./state"
import { toolLocation, viewTool } from "./tool-presentation"

function remember(seen: string[], key: string): boolean {
  if (!key || seen.includes(key)) return false
  seen.push(key)
  boundList(seen, RETAINED_TOOL_ITEMS_MAX)
  return true
}

function toolContentEvents(state: ToolState, item: ToolCallContent): AgentRuntimeEvent[] {
  const key =
    item.type === "diff"
      ? diffKey(item)
      : item.type === "terminal"
        ? (item.terminalId ?? "")
        : `${item.type}:${JSON.stringify(item)}`
  const seen = item.type === "diff" ? state.seenDiffs : item.type === "terminal" ? state.seenTerms : state.seenContent
  if (!remember(seen, key)) return []
  const tool = viewTool(state)
  const events: AgentRuntimeEvent[] = [
    { type: "tool-content", toolCallId: state.id, content: item, display: tool.display, metadata: tool.metadata },
  ]
  if (item.type === "diff")
    events.push({
      type: "file-diff",
      toolCallId: state.id,
      path: item.path ?? "",
      oldText: item.oldText ?? undefined,
      newText: item.newText ?? "",
    })
  if (item.type === "terminal" && item.terminalId)
    events.push({ type: "tool-terminal", toolCallId: state.id, terminalId: item.terminalId })
  return events
}

export function drainContent(state: ToolState, content: ToolCallContent[] | null | undefined): AgentRuntimeEvent[] {
  return (content ?? []).flatMap((item) => toolContentEvents(state, item))
}

export function drainSpots(state: ToolState, locations: Spot[] | null | undefined): AgentRuntimeEvent[] {
  const next = (locations ?? [])
    .filter((item) => remember(state.seenSpots, pathKey(item)))
    .map(toolLocation)
  return next.length ? [{ type: "tool-location", toolCallId: state.id, locations: next }] : []
}
