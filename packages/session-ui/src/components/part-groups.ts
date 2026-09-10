import { canonicalToolName, isSubagentSpawnToolName, type AgentContentPart, type AgentToolPart } from "@claxedo/agent-runtime-contract"

export type PartRef = {
  messageID: string
  partID: string
}

/** Category discriminator for a work group: drives icon + summary priority. */
export type WorkGroupTool = "bash" | "edit" | "write" | "apply_patch" | "webfetch" | "websearch"

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

/*
 * Canonical spellings only. Harness variants (`command`, `read_file`, `ls`) fold into
 * these through `canonicalToolName`, which every predicate below applies, so a new
 * harness spelling is added once in the contract rather than in each vocabulary.
 */
export const CONTEXT_GROUP_TOOLS = new Set(["read", "glob", "grep", "list"])

export const WORK_GROUP_TOOLS = new Set<string>([
  "bash",
  "edit",
  "write",
  "apply_patch",
  "webfetch",
  "websearch",
])

export const EDIT_TOOL_NAMES = new Set(["edit", "write", "apply_patch"])

export const WEB_TOOL_NAMES = new Set(["webfetch", "websearch"])

export const HIDDEN_TOOLS = new Set(["todowrite"])

/**
 * A context group renders its members as compact trigger-only rows (ContextToolGroup
 * builds them from `contextToolTrigger`, bypassing the tool's own renderer), so anything
 * a call produced beyond its title is dropped. A read that returned an image therefore
 * stays standalone — the thumbnail is the whole point of the row.
 */
function producedImage(part: AgentToolPart) {
  const state = part.state
  if (state.status !== "completed") return false
  return !!state.attachments?.some((file) => file.mime.startsWith("image/"))
}

export function isContextGroupTool(part: AgentContentPart): part is AgentToolPart {
  if (part.type !== "tool" || !CONTEXT_GROUP_TOOLS.has(canonicalToolName(part.tool))) return false
  return !producedImage(part)
}

export function isWorkGroupTool(part: AgentContentPart): part is AgentToolPart {
  return part.type === "tool" && WORK_GROUP_TOOLS.has(canonicalToolName(part.tool))
}

/**
 * A tool part that is a subagent spawn. The name is the primary signal and the
 * contract owns its spellings; an MCP tool that answers task work without one of
 * those names declares it on the input instead.
 */
export function isSubagentToolPart(part: { type: string; tool?: string; state?: { input?: unknown } }): boolean {
  if (part.type !== "tool") return false
  if (part.tool && isSubagentSpawnToolName(part.tool)) return true
  const input = part.state?.input
  return typeof input === "object" && input !== null && (input as { intent?: unknown }).intent === "task"
}

function partRef(item: GroupablePart): PartRef {
  return { messageID: item.messageID, partID: item.part.id }
}

function workGroupTool(slice: GroupablePart[]): WorkGroupTool {
  if (slice.some((item) => item.part.type === "tool" && EDIT_TOOL_NAMES.has(canonicalToolName(item.part.tool)))) return "edit"
  if (slice.some((item) => item.part.type === "tool" && WEB_TOOL_NAMES.has(canonicalToolName(item.part.tool)))) return "webfetch"
  return "bash"
}

/**
 * Consecutive context tools fold into a context group at any length; consecutive
 * work tools and consecutive subagent spawns fold only when the run has ≥2 members,
 * so a lone one keeps its own row. Any other part flushes all three runs.
 */
export function groupParts(parts: GroupablePart[]) {
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
    if (slice.length >= 2) {
      result.push({ key: `agents:${first.part.id}`, type: "agents", refs: slice.map(partRef) })
    } else {
      result.push({ key: `part:${first.messageID}:${first.part.id}`, type: "part", ref: partRef(first) })
    }
    taskStart = -1
  }

  parts.forEach((item, index) => {
    const isContext = isContextGroupTool(item.part)
    const isWork = isWorkGroupTool(item.part)
    const isTask = isSubagentToolPart(item.part)

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
