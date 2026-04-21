import { queryOptions, skipToken } from "@tanstack/solid-query"

export const loadSessionsQuery = (directory: string) =>
  queryOptions<null>({ queryKey: [directory, "loadSessions"], queryFn: skipToken })
