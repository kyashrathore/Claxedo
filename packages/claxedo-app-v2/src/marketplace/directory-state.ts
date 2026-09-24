import { createMemo, createSignal } from "solid-js"
import { keepPreviousData, useQuery } from "@tanstack/solid-query"
import { useServer, type MachineInstalled, type PluginCandidate, type PluginSourceRecord } from "@/server"
import { matchesQuery } from "./model"
import {
  ALL,
  categoryChips,
  directorySections,
  personalEntries,
  personalEntryKey,
  sourcesFromCandidates,
  type DirectorySourceView,
} from "./sections"

function createQueries() {
  const server = useServer()
  const catalog = useQuery(() => ({
    ...server.queries.marketplace.catalog(),
    staleTime: Infinity,
    refetchOnMount: "always" as const,
    refetchOnReconnect: false,
    placeholderData: keepPreviousData,
  }))
  const sources = useQuery(() => server.queries.marketplace.sources())
  const machine = useQuery(() => server.queries.marketplace.machineInstalled())
  return { catalog, sources, machine }
}

export function createDirectory() {
  const queries = createQueries()
  const [query, setQuery] = createSignal("")
  const [filter, setFilter] = createSignal(ALL)
  const [category, setCategory] = createSignal(ALL)
  const candidates = () => queries.catalog.data?.candidates ?? []
  const listedSources = () => (queries.sources.error ? [] : (queries.sources.data ?? []))
  const machine = () => (queries.machine.error ? undefined : queries.machine.data)
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
  const personal = createMemo(() =>
    personalEntries({ machine: machine(), query: query(), filter: filter(), category: category() }),
  )
  const categories = createMemo(() => categoryChips(candidates()))
  const counts = createCounts({ candidates, machine, query, filter, listedSources })
  const view = {
    query,
    setQuery,
    filter,
    setFilter,
    category,
    setCategory,
    sections,
    personal,
    sourceViews,
    categories,
  }
  return { ...queries, ...view, ...counts, candidates, listedSources }
}

function createCounts(input: {
  readonly candidates: () => readonly PluginCandidate[]
  readonly machine: () => MachineInstalled | undefined
  readonly query: () => string
  readonly filter: () => string
  readonly listedSources: () => readonly PluginSourceRecord[]
}) {
  const matching = (id: string) => (plugin: PluginCandidate) =>
    plugin.source?.id === id && matchesQuery(plugin, input.query().trim().toLowerCase())
  return {
    sourceCount: (id: string) => input.candidates().filter(matching(id)).length,
    personalCount: () => personalEntries({ machine: input.machine(), query: input.query(), filter: ALL }).length,
    removable: () => input.listedSources().find((source) => source.id === input.filter() && source.canRemove),
  }
}

export function createSelection(input: {
  readonly candidates: () => readonly PluginCandidate[]
  readonly personal: () => ReturnType<typeof personalEntries>
}) {
  const [selectedId, setSelectedId] = createSignal<string>()
  const [personalKey, setPersonalKey] = createSignal<string>()
  const selected = createMemo(() => input.candidates().find((plugin) => plugin.pluginInstanceId === selectedId()))
  const selectedPersonal = createMemo(() => input.personal().find((entry) => personalEntryKey(entry) === personalKey()))
  return {
    selectedId,
    personalKey,
    selected,
    selectedPersonal,
    openPlugin: (id: string) => {
      setPersonalKey(undefined)
      setSelectedId(id)
    },
    openPersonal: (key: string) => {
      setSelectedId(undefined)
      setPersonalKey(key)
    },
    closePlugin: () => setSelectedId(undefined),
    closePersonal: () => setPersonalKey(undefined),
  }
}
