import { createMemo, createResource, type Accessor } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import fuzzysort from "fuzzysort"
import type { PlacementId } from "@/server"
import { placementId as asPlacementId, useServer } from "@/server"
import type { CommandOption, MentionEntry, ShellRegistries } from "@/shell"
import { promptSlashCommands } from "./view/prompt-options"
import type { SlashCommand } from "./view/slash-popover"

export type AtItem =
  | { kind: "file"; id: string; path: string; directory: boolean }
  | { kind: "mention"; id: string; entry: MentionEntry }

export type SlashItem = SlashCommand

export type SuggestionQuery = { kind: "closed" } | { kind: "at"; query: string } | { kind: "slash"; query: string }

const AT_LIMIT = 10

type SuggestionInput = {
  registries: Pick<ShellRegistries, "mentions">
  commandOptions: Accessor<CommandOption[]>
  placementId: Accessor<PlacementId | undefined>
  harness: Accessor<string | undefined>
  query: Accessor<SuggestionQuery>
}

const DOCUMENTS_COMMAND = "documents.open"

function createAtItems(input: SuggestionInput, atQuery: Accessor<string | undefined>) {
  const server = useServer()
  const files = useQuery(() => {
    const placementId = input.placementId()
    const query = atQuery()
    const options = server.queries.files.search(placementId ?? asPlacementId(""), query ?? "", "all")
    return { ...options, enabled: placementId !== undefined && query !== undefined }
  })
  const [mentions] = createResource(
    () => (atQuery() === undefined ? undefined : { query: atQuery() ?? "", sources: input.registries.mentions.list() }),
    async ({ query, sources }) => (await Promise.all(sources.map((source) => source.search(query)))).flat(),
    { initialValue: [] },
  )
  const items = createMemo((): AtItem[] => {
    if (atQuery() === undefined) return []
    const entries = mentions.latest.map((entry): AtItem => ({ kind: "mention", id: `mention:${entry.id}`, entry }))
    const paths = (files.data ?? []).slice(0, AT_LIMIT).map((path): AtItem => ({ kind: "file", id: `file:${path}`, path, directory: path.endsWith("/") }))
    return [...entries, ...paths]
  })
  return { items, loading: () => files.isPending && atQuery() !== undefined, failed: () => files.error ?? undefined }
}

function createHarnessCommands(input: SuggestionInput, slashQuery: Accessor<string | undefined>) {
  const server = useServer()
  const commands = useQuery(() => {
    const placementId = input.placementId()
    const harness = input.harness()
    const options = server.queries.harnesses.commands(placementId ?? asPlacementId(""), harness ?? "")
    return { ...options, enabled: placementId !== undefined && harness !== undefined && slashQuery() !== undefined }
  })
  return { commands: () => commands.data, failed: () => commands.error ?? undefined }
}

function createSlashItems(input: SuggestionInput, slashQuery: Accessor<string | undefined>) {
  const harnessCommands = createHarnessCommands(input, slashQuery)
  const items = createMemo((): SlashItem[] => {
    const query = slashQuery()
    if (query === undefined) return []
    const all = promptSlashCommands({ commandOptions: input.commandOptions(), customCommands: harnessCommands.commands() }).filter((command) => command.id !== DOCUMENTS_COMMAND)
    if (!query) return all
    return fuzzysort.go(query, all, { keys: ["trigger", "title"] }).map((result) => result.obj)
  })
  return { items, failed: harnessCommands.failed }
}

export function createSuggestions(input: SuggestionInput) {
  const queryOf = (kind: "at" | "slash") =>
    createMemo(() => {
      const current = input.query()
      return current.kind === kind ? current.query : undefined
    })
  const at = createAtItems(input, queryOf("at"))
  const slash = createSlashItems(input, queryOf("slash"))
  return { atItems: at.items, atLoading: at.loading, atFailed: at.failed, slashItems: slash.items, slashFailed: slash.failed }
}

