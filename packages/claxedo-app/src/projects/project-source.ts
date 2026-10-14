import { unreachable } from "@/lib/machine"
import { repositoryName, type ProjectSource } from "@/server"

export function draftProjectName(source: ProjectSource): string {
  if (source.kind === "folder") return source.path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? ""
  return repositoryName(source)
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
