import { canonicalToolName, type AgentToolPart } from "@claxedo/agent-runtime-contract"
import type { IconProps } from "@opencode-ai/ui/icon"
import type { UiI18n } from "@opencode-ai/ui/context/i18n"
import { getFilename } from "@opencode-ai/ui/utils/path"
import { genericToolIcon, toolActionPhrase } from "./basic-tool"
import { clampLabel } from "./message-part-text"
import { EDIT_TOOL_NAMES, WEB_TOOL_NAMES } from "./part-groups"
import { stripShellWrapper } from "./shell-wrapper"

export type WorkGroupCounts = {
  edited: number
  commands: number
  fetched: number
  searched: number
  /** Members no named bucket claims, in order, so the summary can still name them. */
  other: AgentToolPart[]
}

export function workGroupSummary(parts: AgentToolPart[]): WorkGroupCounts {
  const counts: WorkGroupCounts = { edited: 0, commands: 0, fetched: 0, searched: 0, other: [] }
  for (const part of parts) {
    switch (canonicalToolName(part.tool)) {
      case "edit":
      case "write":
      case "apply_patch":
        counts.edited += 1
        break
      case "bash":
        counts.commands += 1
        break
      case "webfetch":
        counts.fetched += 1
        break
      case "websearch":
        counts.searched += 1
        break
      default:
        counts.other.push(part)
    }
  }
  return counts
}

export function workGroupIcon(parts: AgentToolPart[]): IconProps["name"] {
  const tools = parts.map((part) => canonicalToolName(part.tool))
  if (tools.some((tool) => EDIT_TOOL_NAMES.has(tool))) return "pencil-line"
  if (tools.some((tool) => WEB_TOOL_NAMES.has(tool))) return "magnifying-glass"
  if (tools.some((tool) => tool === "bash")) return "terminal"
  const [icon, ...rest] = new Set(parts.map((part) => genericToolIcon(part.tool, part.state.input)))
  return icon && rest.length === 0 ? icon : "wrench"
}

/** How a row names one call: the action its name reads as, or the name itself. */
function toolLabel(part: AgentToolPart, i18n: UiI18n) {
  return toolActionPhrase(part.tool, i18n) ?? canonicalToolName(part.tool)
}

/**
 * The members the named buckets leave over. A single call is named the way its own row
 * names it; a run of one tool is counted by that tool; a mixed run has no shared name
 * to count by, so it says how many calls it hides.
 */
function otherSegment(parts: AgentToolPart[], pending: boolean, i18n: UiI18n): string | undefined {
  const first = parts[0]
  if (!first) return undefined
  if (parts.length === 1) {
    const label = toolLabel(first, i18n)
    return pending ? `running ${label}` : label
  }
  const labels = [...new Set(parts.map((part) => toolLabel(part, i18n).toLowerCase()))]
  const [name] = labels
  if (labels.length === 1 && name) {
    // A run of one tool counts by that tool: a pluralizable name keeps the
    // "ran 2 skills" shape, an opaque one keeps its label verbatim.
    if (/^[a-z][a-z0-9]*$/.test(name)) {
      return pending ? `running ${name}s` : `ran ${parts.length} ${name}s`
    }
    return pending ? `running ${parts.length} ${name}` : `used ${parts.length} ${name}`
  }
  return pending ? `running ${labels.join(", ")}` : `used ${labels.join(", ")}`
}

// Segmented summary: present-continuous while running, past tense when settled;
// leading segment sentence-case, followers lowercase, joined with " · ".
function workGroupSegments(counts: WorkGroupCounts, pending: boolean, i18n: UiI18n): string[] {
  const segs: string[] = []
  if (counts.edited > 0)
    segs.push(pending ? "editing files" : `edited ${counts.edited} ${counts.edited === 1 ? "file" : "files"}`)
  if (counts.commands > 0)
    segs.push(pending ? "running commands" : `ran ${counts.commands} ${counts.commands === 1 ? "command" : "commands"}`)
  if (counts.fetched > 0)
    segs.push(pending ? "fetching pages" : `fetched ${counts.fetched} ${counts.fetched === 1 ? "page" : "pages"}`)
  if (counts.searched > 0) segs.push(pending ? "searching the web" : "searched the web")
  const other = otherSegment(counts.other, pending, i18n)
  if (other) segs.push(other)
  return segs
}

export function workGroupTitle(counts: WorkGroupCounts, pending: boolean, i18n: UiI18n): string {
  const segs = workGroupSegments(counts, pending, i18n)
  if (segs.length === 0) return pending ? "Working" : "Worked"
  return segs.map((seg, i) => (i === 0 ? seg.charAt(0).toUpperCase() + seg.slice(1) : seg)).join(" · ")
}

/**
 * "active" header kind: while a member is still running, the group header shows
 * that member's live summary instead of the settled aggregate — so a long run of tool
 * calls stays ONE row that keeps updating, rather than appending a row per call.
 */
export function workGroupActiveLabel(parts: AgentToolPart[], i18n: UiI18n, busy = false): string | undefined {
  const active = parts.find((part) => part.state.status === "pending" || part.state.status === "running")
    ?? (busy ? parts.at(-1) : undefined)
  // `busy` belongs to the trailing group of the active turn. A completed member
  // does not close that group; the next transcript group or turn completion does.
  if (!active) return undefined
  const input = (active.state.input ?? {})
  const text = (key: string) => (typeof input[key] === "string" ? (input[key]) : undefined)

  switch (canonicalToolName(active.tool)) {
    case "bash": {
      const command = text("command")
      return command ? clampLabel(`Running ${stripShellWrapper(command)}`) : "Running command"
    }
    case "edit":
    case "write": {
      const file = text("filePath") ?? text("path")
      return file ? clampLabel(`Editing ${getFilename(file)}`) : "Editing files"
    }
    case "apply_patch":
      return "Applying patch"
    case "webfetch": {
      const url = text("url")
      return url ? clampLabel(`Fetching ${url}`) : "Fetching page"
    }
    case "websearch": {
      const query = text("query")
      return query ? clampLabel(`Searching ${query}`) : "Searching the web"
    }
    default:
      return clampLabel(`Running ${toolLabel(active, i18n)}`)
  }
}

