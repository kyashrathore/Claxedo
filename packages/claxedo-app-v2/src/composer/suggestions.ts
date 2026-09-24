import { createMemo, createResource, type Accessor } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import fuzzysort from "fuzzysort"
import type { PlacementId } from "@/server"
import { useServer } from "@/server"
import type { CommandEntry, MentionEntry, ShellRegistries } from "@/shell"

export type AtItem =
  | { kind: "file"; id: string; path: string; directory: boolean }
  | { kind: "mention"; id: string; entry: MentionEntry }

export type SlashItem =
  | { kind: "goal"; id: "goal"; trigger: "goal"; title: string }
  | { kind: "command"; id: string; trigger: string; title: string; keybinding?: string; entry: CommandEntry }

export type SuggestionQuery = { kind: "closed" } | { kind: "at"; query: string } | { kind: "slash"; query: string }

const AT_LIMIT = 10

export function createSuggestions(input: {
  registries: Pick<ShellRegistries, "commands" | "mentions">
  placementId: Accessor<PlacementId | undefined>
  query: Accessor<SuggestionQuery>
  goalAvailable: Accessor<boolean>
  goalTitle: () => string
}) {
  const server = useServer()
  const atQuery = createMemo(() => {
    const current = input.query()
    return current.kind === "at" ? current.query : undefined
  })
  const slashQuery = createMemo(() => {
    const current = input.query()
    return current.kind === "slash" ? current.query : undefined
  })

  const files = useQuery(() => {
    const placementId = input.placementId()
    const query = atQuery()
    const options = server.queries.files.search(placementId ?? ("" as PlacementId), query ?? "")
    return { ...options, enabled: placementId !== undefined && query !== undefined }
  })

  const [mentions] = createResource(
    () => (atQuery() === undefined ? undefined : { query: atQuery() ?? "", sources: input.registries.mentions.list() }),
    async ({ query, sources }) => {
      const lists = await Promise.all(sources.map((source) => source.search(query)))
      return lists.flat()
    },
    { initialValue: [] },
  )

  const atItems = createMemo((): AtItem[] => {
    if (atQuery() === undefined) return []
    const entries = mentions.latest.map((entry): AtItem => ({ kind: "mention", id: `mention:${entry.id}`, entry }))
    const paths = (files.data ?? []).slice(0, AT_LIMIT).map(
      (path): AtItem => ({ kind: "file", id: `file:${path}`, path, directory: path.endsWith("/") }),
    )
    return [...entries, ...paths]
  })

  const slashItems = createMemo((): SlashItem[] => {
    const query = slashQuery()
    if (query === undefined) return []
    const commands = input.registries.commands
      .list()
      .filter((entry) => !entry.when || entry.when())
      .map((entry): SlashItem => ({ kind: "command", id: entry.id, trigger: entry.id, title: entry.title(), keybinding: entry.keybinding, entry }))
    const all: SlashItem[] = input.goalAvailable()
      ? [{ kind: "goal", id: "goal", trigger: "goal", title: input.goalTitle() }, ...commands]
      : commands
    if (!query) return all
    return fuzzysort.go(query, all, { keys: ["trigger", "title"] }).map((result) => result.obj)
  })

  return {
    atItems,
    slashItems,
    loading: () => files.isPending && atQuery() !== undefined,
    failed: () => files.error ?? undefined,
  }
}

export type Suggestions = ReturnType<typeof createSuggestions>
