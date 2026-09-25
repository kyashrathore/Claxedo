import { unreachable } from "@/lib/machine"
import type { ProjectSource } from "@/server"

function lastSegment(value: string) {
  return value.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? ""
}

export function draftProjectName(source: ProjectSource): string {
  switch (source.kind) {
    case "folder":
      return lastSegment(source.path)
    case "repository":
      return lastSegment(source.url).replace(/\.git$/, "")
    case "connectedRepository":
      return lastSegment(source.fullName)
    default:
      return unreachable(source)
  }
}

export function sourceLabel(source: ProjectSource | undefined): string {
  if (!source) return ""
  switch (source.kind) {
    case "folder":
      return source.path
    case "repository":
      return source.url
    case "connectedRepository":
      return source.fullName
    default:
      return unreachable(source)
  }
}
