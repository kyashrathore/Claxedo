import { canonicalToolName, isSubagentSpawnToolName, type AgentContentPart, type AgentToolPart } from "@claxedo/agent-runtime-contract"
import { asRecord } from "@claxedo/helpers/guards"
import { claxedoToolName } from "./claxedo-tool-view"

export type PartRef = {
  messageID: string
  partID: string
}

export type WorkGroupTool = "bash" | "edit" | "webfetch"

export type PartGroup =
  | {
      key: string
      type: "part"
      ref: PartRef
    }
  | {
      key: string
      type: "context"
      refs: PartRef[]
    }
  | {
      key: string
      type: "work"
      tool: WorkGroupTool
      refs: PartRef[]
    }
  | {
      key: string
      type: "agents"
      refs: PartRef[]
    }

export type GroupablePart = { messageID: string; part: AgentContentPart }

export const CONTEXT_GROUP_TOOLS = new Set(["read", "glob", "grep", "list"])

export const STANDALONE_TOOLS = new Set(["question"])

export const EDIT_TOOL_NAMES = new Set(["edit", "write", "apply_patch"])

export const WEB_TOOL_NAMES = new Set(["webfetch", "websearch"])

export const HIDDEN_TOOLS = new Set(["todowrite"])

export function isHiddenTool(part: { type: string; tool?: string }): boolean {
  return part.type === "tool" && !!part.tool && HIDDEN_TOOLS.has(canonicalToolName(part.tool))
}

function producedImage(part: AgentToolPart) {
  const state = part.state
  if (state.status !== "completed") return false
  return !!state.attachments?.some((file) => file.mime.startsWith("image/"))
}

export function isStandaloneTool(part: { type: string; tool?: string }): boolean {
  return part.type === "tool" && !!part.tool && STANDALONE_TOOLS.has(canonicalToolName(part.tool))
}

export function isPendingQuestion(part: { type: string; tool?: string; state?: { status?: string } }): boolean {
  if (!isStandaloneTool(part)) return false
  const status = part.state?.status
  return status === "pending" || status === "running"
}

export function isContextGroupTool(part: AgentContentPart): part is AgentToolPart {
  if (part.type !== "tool" || !CONTEXT_GROUP_TOOLS.has(canonicalToolName(part.tool))) return false
  return !isClaxedoToolPart(part) && !producedImage(part)
}

export function isWorkGroupTool(part: AgentContentPart): part is AgentToolPart {
  if (part.type !== "tool") return false
  if (CONTEXT_GROUP_TOOLS.has(canonicalToolName(part.tool)) || isHiddenTool(part) || isStandaloneTool(part)) return false
  return !isSubagentToolPart(part) && !isClaxedoToolPart(part)
}

export function isClaxedoToolPart(part: { type: string; tool?: string; state?: { input?: unknown } }): boolean {
  if (part.type !== "tool" || !part.tool) return false
  return claxedoToolName(part.tool, asRecord(part.state?.input)) !== undefined
}

export function isSubagentToolPart(part: { type: string; tool?: string; state?: { input?: unknown } }): boolean {
  if (part.type !== "tool") return false
  if (part.tool && isSubagentSpawnToolName(part.tool)) return true
  const input = part.state?.input
  return typeof input === "object" && input !== null && (input as { intent?: unknown }).intent === "task"
}

function spawnFailed(part: AgentContentPart) {
  return part.type === "tool" && part.state.status === "error"
}

export function isSubagentHostPart(part: AgentContentPart): boolean {
  return isSubagentToolPart(part)
}

function partRef(item: GroupablePart): PartRef {
  return { messageID: item.messageID, partID: item.part.id }
}

function workGroupTool(slice: GroupablePart[]): WorkGroupTool {
  if (slice.some((item) => item.part.type === "tool" && EDIT_TOOL_NAMES.has(canonicalToolName(item.part.tool)))) return "edit"
  if (slice.some((item) => item.part.type === "tool" && WEB_TOOL_NAMES.has(canonicalToolName(item.part.tool)))) return "webfetch"
  return "bash"
}

export function groupParts(input: GroupablePart[]) {
  const parts = input.filter((item) => !isPendingQuestion(item.part))
  const result: PartGroup[] = []
  let contextStart = -1
  let workStart = -1
  let taskStart = -1

  const flushContext = (end: number) => {
    if (contextStart < 0) return
    const first = parts[contextStart]
    if (!first) {
      contextStart = -1
      return
    }
    result.push({
      key: `context:${first.part.id}`,
      type: "context",
      refs: parts.slice(contextStart, end + 1).map(partRef),
    })
    contextStart = -1
  }

  const flushWork = (end: number) => {
    if (workStart < 0) return
    const slice = parts.slice(workStart, end + 1)
    const first = parts[workStart]
    if (!first) {
      workStart = -1
      return
    }
    if (slice.length >= 2) {
      result.push({
        key: `work:${first.part.id}`,
        type: "work",
        tool: workGroupTool(slice),
        refs: slice.map(partRef),
      })
    } else {
      result.push({ key: `part:${first.messageID}:${first.part.id}`, type: "part", ref: partRef(first) })
    }
    workStart = -1
  }

  const flushTask = (end: number) => {
    if (taskStart < 0) return
    const slice = parts.slice(taskStart, end + 1)
    const first = parts[taskStart]
    if (!first) {
      taskStart = -1
      return
    }
    result.push({ key: `agents:${first.part.id}`, type: "agents", refs: slice.map(partRef) })
    taskStart = -1
  }

  parts.forEach((item, index) => {
    const isContext = isContextGroupTool(item.part)
    const isWork = isWorkGroupTool(item.part)
    const isTask = !isClaxedoToolPart(item.part) && isSubagentHostPart(item.part) && !spawnFailed(item.part)

    if (isContext) {
      flushWork(index - 1)
      flushTask(index - 1)
      if (contextStart < 0) contextStart = index
      return
    }

    if (isWork) {
      flushContext(index - 1)
      flushTask(index - 1)
      if (workStart < 0) workStart = index
      return
    }

    if (isTask) {
      flushContext(index - 1)
      flushWork(index - 1)
      if (taskStart < 0) taskStart = index
      return
    }

    flushContext(index - 1)
    flushWork(index - 1)
    flushTask(index - 1)
    result.push({ key: `part:${item.messageID}:${item.part.id}`, type: "part", ref: partRef(item) })
  })

  flushContext(parts.length - 1)
  flushWork(parts.length - 1)
  flushTask(parts.length - 1)
  return result
}

function sameRef(a: PartRef, b: PartRef) {
  return a.messageID === b.messageID && a.partID === b.partID
}

function sameRefs(a: PartRef[], b: PartRef[]) {
  if (a.length !== b.length) return false
  return a.every((ref, i) => sameRef(ref, b[i]))
}

function sameGroup(a: PartGroup, b: PartGroup) {
  if (a === b) return true
  if (a.key !== b.key) return false
  if (a.type !== b.type) return false
  if (a.type === "part") {
    if (b.type !== "part") return false
    return sameRef(a.ref, b.ref)
  }
  if (a.type === "work") {
    if (b.type !== "work") return false
    if (a.tool !== b.tool) return false
    return sameRefs(a.refs, b.refs)
  }
  if (a.type === "agents") {
    if (b.type !== "agents") return false
    return sameRefs(a.refs, b.refs)
  }
  if (b.type !== "context") return false
  return sameRefs(a.refs, b.refs)
}

export function sameGroups(a: readonly PartGroup[] | undefined, b: readonly PartGroup[] | undefined) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((item, i) => sameGroup(item, b[i]))
}
