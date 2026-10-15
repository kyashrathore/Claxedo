import { unreachable } from "@/lib/machine"
import { repositoryName, type ProjectSource } from "@/server"
import type { ProjectsText } from "./i18n"

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

export function pastedRepositoryHint(t: ProjectsText, host: string | undefined, connected: boolean): string {
  return host && connected ? t("projects.create.url.hint.connected", { host }) : t("projects.create.url.hint.none")
}
