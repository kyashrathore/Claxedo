import { createMemo, type Accessor } from "solid-js"
import { keyedQueries } from "@/lib/keyed-queries"
import { useServer, type AppError, type FileNode, type PlacementId } from "@/server"
import { useFilesApi } from "./api"
import { sortNodes } from "./model"
import type { Files } from "./store"

export type TreeDirState = {
  readonly expanded: boolean
  readonly loaded: boolean
  readonly loading: boolean
  readonly error: AppError | undefined
  readonly retry: () => void
}

export type TreeSource = {
  readonly children: (dir: string) => readonly FileNode[]
  readonly state: (dir: string) => TreeDirState
  readonly expand: (dir: string) => void
  readonly collapse: (dir: string) => void
}

export type TreeExpansion = Pick<Files, "expanded" | "expandedDirs" | "setExpanded">

export function createTreeSource(files: TreeExpansion, placementId: Accessor<PlacementId>, enabled: Accessor<boolean>): TreeSource {
  const api = useFilesApi()
  const dirs = createMemo(() => ["", ...files.expandedDirs()])
  const resultOf = keyedQueries(dirs, (dir) => ({ ...api.tree(placementId(), dir), enabled: enabled() }))
  return {
    children: (dir) => sortNodes(resultOf(dir)?.data ?? []),
    state: (dir) => {
      const result = resultOf(dir)
      return {
        expanded: dir === "" || files.expanded(dir),
        loaded: result?.status === "success",
        loading: result?.status === "pending" && result.fetchStatus === "fetching",
        error: result?.status === "error" ? (result.error ?? undefined) : undefined,
        retry: () => void result?.refetch(),
      }
    },
    expand: (dir) => files.setExpanded(dir, true),
    collapse: (dir) => files.setExpanded(dir, false),
  }
}

export function useRootListingPrefetch(): (placementId: PlacementId) => void {
  const server = useServer()
  const api = useFilesApi()
  return (placementId) => void server.queryClient.prefetchQuery(api.tree(placementId, ""))
}
