export type SessionFilter = {
  archived?: "active" | "all" | "archived"
  status?: string[]
  environment?: string[]
  git?: string[]
}

export function applySessionFilter(url: URL, filter?: SessionFilter) {
  if (!filter) return
  if (filter.archived === "all") url.searchParams.set("archived", "all")
  if (filter.archived === "archived") url.searchParams.set("archived", "archived")
  if (filter.status?.length) url.searchParams.set("filter.status", filter.status.join(","))
  if (filter.environment?.length) url.searchParams.set("filter.environment", filter.environment.join(","))
  if (filter.git?.length) url.searchParams.set("filter.git", filter.git.join(","))
}
