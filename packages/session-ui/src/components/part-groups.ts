import { canonicalToolName, isSubagentSpawnToolName, type AgentContentPart, type AgentToolPart } from "@claxedo/agent-runtime-contract"

export type PartRef = {
  messageID: string
  partID: string
}

/**
 * How a run of work rows is categorised for group identity. Nothing renders from it:
 * `work-group-summary.ts` derives both the icon and the summary from the member parts.
 */
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

/*
 * Canonical spellings only. Harness variants (`command`, `read_file`, `ls`) fold into
 * these through `canonicalToolName`, which every predicate below applies, so a new
 * harness spelling is added once in the contract rather than in each vocabulary.
 */
export const CONTEXT_GROUP_TOOLS = new Set(["read", "glob", "grep", "list"])

/**
 * Tools that address the reader rather than doing work on their behalf. A settled
 * question holds the answer they typed — the one part of the turn they authored — so
 * folding it into a run of machinery would bury it.
 */
export const STANDALONE_TOOLS = new Set(["question"])

export const EDIT_TOOL_NAMES = new Set(["edit", "write", "apply_patch"])

export const WEB_TOOL_NAMES = new Set(["webfetch", "websearch"])

export const HIDDEN_TOOLS = new Set(["todowrite"])

/** A tool whose call renders no row, in whichever spelling the harness sent. */
export function isHiddenTool(part: { type: string; tool?: string }): boolean {
  return part.type === "tool" && !!part.tool && HIDDEN_TOOLS.has(canonicalToolName(part.tool))
}

/**
 * A context group is collapsed until a reader opens it, and it summarises its members as
 * a count of files read. An image is the one thing a read returns that a count cannot
 * stand in for, so a read that returned one stays a standalone row where its thumbnail
 * is on screen.
 */
function producedImage(part: AgentToolPart) {
  const state = part.state
  if (state.status !== "completed") return false
  return !!state.attachments?.some((file) => file.mime.startsWith("image/"))
}

export function isStandaloneTool(part: { type: string; tool?: string }): boolean {
  return part.type === "tool" && !!part.tool && STANDALONE_TOOLS.has(canonicalToolName(part.tool))
}

/**
 * A question renders nothing until it is answered, so until then it is not a row at
 * all: it can neither break a run of machinery nor join one.
 */
export function isPendingQuestion(part: { type: string; tool?: string; state?: { status?: string } }): boolean {
  if (!isStandaloneTool(part)) return false
  const status = part.state?.status
  return status === "pending" || status === "running"
}

export function isContextGroupTool(part: AgentContentPart): part is AgentToolPart {
  if (part.type !== "tool" || !CONTEXT_GROUP_TOOLS.has(canonicalToolName(part.tool))) return false
  return !producedImage(part)
}

/**
 * Work is everything the agent did that is not context-gathering, a subagent, hidden,
 * or addressed to the reader — named by exclusion, because a list could only ever name
 * the tools it knew, and every tool missing from it breaks a run into its own row.
 */
export function isWorkGroupTool(part: AgentContentPart): part is AgentToolPart {
  if (part.type !== "tool") return false
  if (CONTEXT_GROUP_TOOLS.has(canonicalToolName(part.tool)) || isHiddenTool(part) || isStandaloneTool(part)) return false
  return !isSubagentToolPart(part)
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

/**
 * A spawn whose own tool call failed delegated nothing — no child session was ever
 * bound, so the chip row it would join has nothing to draw. It is a failed tool call,
 * and the error text is the only thing that reports what happened.
 */
function spawnFailed(part: AgentContentPart) {
  return part.type === "tool" && part.state.status === "error"
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
 * Consecutive context tools fold into a context group at any length, and consecutive
 * subagent spawns into an agents group at any length; a run of work tools folds only
 * when it has ≥2 members, so a lone one keeps its own row. Any other part flushes all
 * three runs.
 */
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
    // A lone spawn makes an agents group too: the chip row is the only shape that draws one.
    result.push({ key: `agents:${first.part.id}`, type: "agents", refs: slice.map(partRef) })
    taskStart = -1
  }

  parts.forEach((item, index) => {
    const isContext = isContextGroupTool(item.part)
    const isWork = isWorkGroupTool(item.part)
    const isTask = isSubagentToolPart(item.part) && !spawnFailed(item.part)

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
