import { createMemo, type Accessor } from "solid-js"
import { useQueries } from "@tanstack/solid-query"
import type { AppError, FileNode, PlacementId } from "@/server"
import { useFilesApi } from "./api"
import { sortNodes } from "./model"
import { useFiles } from "./store"

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

export function createTreeSource(placementId: Accessor<PlacementId>, enabled: Accessor<boolean>): TreeSource {
  const api = useFilesApi()
  const files = useFiles()
  const dirs = createMemo(() => ["", ...files.expandedDirs()])
  const results = useQueries(() => ({
    queries: dirs().map((dir) => ({ ...api.tree(placementId(), dir), enabled: enabled() })),
  }))
  const resultOf = (dir: string) => {
    const index = dirs().indexOf(dir)
    return index === -1 ? undefined : results[index]
  }
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
