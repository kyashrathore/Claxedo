import { batch, createComputed, createMemo, on, type Accessor } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import type { PlacementId } from "@/server"
import { useFilesApi } from "./api"
import { debouncedQuery } from "./search-query"
import { buildSearchTree, createSearchSource, samePaths, type SearchTree } from "./search-tree"
import { useFiles } from "./store"
import { createTreeSource, type TreeSource } from "./tree-source"

export type SearchView = {
  readonly listing: TreeSource
  readonly query: Accessor<string>
  readonly source: Accessor<TreeSource>
  readonly pending: Accessor<boolean>
  readonly empty: Accessor<boolean>
}

function createSearchResults(placementId: Accessor<PlacementId>, query: Accessor<string>) {
  const api = useFilesApi()
  const search = useQuery(() => ({ ...api.search(placementId(), query()), enabled: query().length > 0 }))
  const matches = createMemo<readonly string[] | undefined>(
    (previous) => {
      if (!query()) return undefined
      return search.isSuccess ? search.data : previous
    },
    undefined,
    { equals: samePaths },
  )
  const tree = createMemo<SearchTree | undefined>((previous) => {
    const paths = matches()
    return paths ? buildSearchTree(paths, previous) : undefined
  })
  return { search, matches, tree }
}

export function createSearchView(placementId: Accessor<PlacementId>, active: Accessor<boolean>): SearchView {
  const files = useFiles()
  const query = debouncedQuery(
    createMemo(() => files.search().trim()),
    placementId,
  )
  const listing = createTreeSource(files, placementId, createMemo(() => active() && !query()))
  const { search, matches, tree } = createSearchResults(placementId, query)
  createComputed(
    on(tree, (current) => {
      if (!current) return
      batch(() => {
        for (const dir of current.dirs) listing.expand(dir)
      })
    }),
  )
  const searching = createMemo(() => {
    const current = tree()
    return current ? createSearchSource(listing, current) : listing
  })
  return {
    listing,
    query,
    source: searching,
    pending: () => !!query() && matches() === undefined && search.isPending,
    empty: () => !!query() && search.isSuccess && matches()?.length === 0,
  }
}
