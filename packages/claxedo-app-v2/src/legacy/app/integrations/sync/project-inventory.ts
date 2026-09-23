import { useShellQueryOptions as useQueryOptions } from "@/app/integrations/sync/query-options"

export type ProjectInventoryQueryOptions = ReturnType<ReturnType<typeof useQueryOptions>["projects"]>
export type ProjectInventorySource = {
  projects: () => ProjectInventoryQueryOptions
}

export function projectInventoryQuery(input: { source: ProjectInventorySource }) {
  return input.source.projects()
}

export function projectInventoryQueryKey(input: { source: ProjectInventorySource }) {
  return projectInventoryQuery(input).queryKey
}

export function useProjectInventoryActions() {
  const source = useQueryOptions()
  return {
    query: () => projectInventoryQuery({ source }),
    queryKey: () => projectInventoryQueryKey({ source }),
  }
}
