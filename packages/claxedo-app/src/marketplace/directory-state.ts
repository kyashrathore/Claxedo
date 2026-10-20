import { createMemo, createSignal } from "solid-js"
import { keepPreviousData, useQuery } from "@tanstack/solid-query"
import { useServer, type PluginCandidate, type PluginSourceRecord } from "@/server"
import { matchesQuery } from "./model"
import { ALL, categoryChips, directorySections, sourcesFromCandidates, type DirectorySourceView } from "./sections"

function createDirectoryQueries() {
  const server = useServer()
  const catalog = useQuery(() => ({
    ...server.queries.marketplace.catalog(),
    staleTime: Infinity,
    refetchOnMount: "always" as const,
    refetchOnReconnect: false,
    placeholderData: keepPreviousData,
  }))
  const sources = useQuery(() => server.queries.marketplace.sources())
  return { catalog, sources }
}

export function createDirectory() {
  const queries = createDirectoryQueries()
  const [query, setQuery] = createSignal("")
  const [filter, setFilter] = createSignal(ALL)
  const [category, setCategory] = createSignal(ALL)
  const candidates = () => queries.catalog.data?.candidates ?? []
  const listedSources = () => (queries.sources.error ? [] : (queries.sources.data ?? []))
  const sourceViews = createMemo<readonly DirectorySourceView[]>(() =>
    listedSources().length > 0 ? listedSources() : sourcesFromCandidates(candidates()),
  )
  const sections = createMemo(() =>
    directorySections({
      candidates: candidates(),
      sources: sourceViews(),
      query: query(),
      filter: filter(),
      category: category(),
    }),
  )
  const categories = createMemo(() => categoryChips(candidates()))
  const counts = createCounts({ candidates, query, filter, listedSources })
  const view = {
    query,
    setQuery,
    filter,
    setFilter,
    category,
    setCategory,
    sections,
    sourceViews,
    categories,
  }
  return { ...queries, ...view, ...counts, candidates, listedSources }
}

function createCounts(input: {
  readonly candidates: () => readonly PluginCandidate[]
  readonly query: () => string
  readonly filter: () => string
  readonly listedSources: () => readonly PluginSourceRecord[]
}) {
  const matching = (id: string) => (plugin: PluginCandidate) =>
    plugin.source?.id === id && matchesQuery(plugin, input.query().trim().toLowerCase())
  return {
    sourceCount: (id: string) => input.candidates().filter(matching(id)).length,
    removable: () => input.listedSources().find((source) => source.id === input.filter() && source.canRemove),
  }
}

type SelectedPlugin = { readonly kind: "agent" | "app"; readonly id: string }

export function createSelection(input: { readonly candidates: () => readonly PluginCandidate[] }) {
  const [selection, setSelection] = createSignal<SelectedPlugin>()
  const idOf = (kind: SelectedPlugin["kind"]) => {
    const current = selection()
    return current?.kind === kind ? current.id : undefined
  }
  const selectedId = () => idOf("agent")
  const selected = createMemo(() => input.candidates().find((plugin) => plugin.pluginInstanceId === selectedId()))
  return {
    selectedId,
    selected,
    selectedAppId: () => idOf("app"),
    openPlugin: (id: string) => setSelection({ kind: "agent", id }),
    openAppPlugin: (id: string) => setSelection({ kind: "app", id }),
    closePlugin: () => setSelection(undefined),
  }
}
