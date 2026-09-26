import { canonicalToolName, type AgentToolPart } from "@claxedo/agent-runtime-contract"
import { type IconProps, getFilename } from "@/ui"
import type { TranscriptI18n } from "./i18n"
import { genericToolIcon, toolActionPhrase } from "./basic-tool"
import { clampLabel } from "./message-part-text"
import { EDIT_TOOL_NAMES, WEB_TOOL_NAMES } from "./part-groups"
import { stripShellWrapper } from "./shell-wrapper"

export type WorkGroupCounts = {
  edited: number
  commands: number
  fetched: number
  searched: number
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

function toolLabel(part: AgentToolPart, i18n: TranscriptI18n) {
  return toolActionPhrase(part.tool, i18n) ?? canonicalToolName(part.tool)
}

function otherSegment(parts: AgentToolPart[], pending: boolean, i18n: TranscriptI18n): string | undefined {
  const first = parts[0]
  if (!first) return undefined
  if (parts.length === 1) {
    const label = toolLabel(first, i18n)
    return pending ? `running ${label}` : label
  }
  const labels = [...new Set(parts.map((part) => toolLabel(part, i18n).toLowerCase()))]
  const [name] = labels
  if (labels.length === 1 && name) {
    if (/^[a-z][a-z0-9]*$/.test(name)) {
      return pending ? `running ${name}s` : `ran ${parts.length} ${name}s`
    }
    return pending ? `running ${parts.length} ${name}` : `used ${parts.length} ${name}`
  }
  return pending ? `running ${labels.join(", ")}` : `used ${labels.join(", ")}`
}

function workGroupSegments(counts: WorkGroupCounts, pending: boolean, i18n: TranscriptI18n): string[] {
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

export function workGroupTitle(counts: WorkGroupCounts, pending: boolean, i18n: TranscriptI18n): string {
  const segs = workGroupSegments(counts, pending, i18n)
  if (segs.length === 0) return pending ? "Working" : "Worked"
  return segs.map((seg, i) => (i === 0 ? seg.charAt(0).toUpperCase() + seg.slice(1) : seg)).join(" · ")
}

export function workGroupActiveLabel(parts: AgentToolPart[], i18n: TranscriptI18n, busy = false): string | undefined {
  const active = parts.find((part) => part.state.status === "pending" || part.state.status === "running")
    ?? (busy ? parts.at(-1) : undefined)
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

