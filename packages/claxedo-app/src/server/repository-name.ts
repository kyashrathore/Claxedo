import type { ProjectSource } from "./types"

export type RepositorySource = Exclude<ProjectSource, { readonly kind: "folder" }>

export function repositoryName(source: RepositorySource): string {
  const path = source.kind === "repository" ? source.url : source.fullName
  const last = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path
  return last.replace(/\.git$/, "")
}
