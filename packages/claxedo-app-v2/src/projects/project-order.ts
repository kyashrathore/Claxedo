import type { Project } from "@/server"

export function inCatalogOrder<T extends Pick<Project, "id">>(projects: readonly T[]): T[] {
  return [...projects].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
