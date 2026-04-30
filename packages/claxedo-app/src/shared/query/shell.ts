import type { Command, Project, ProviderListResponse } from "@opencode-ai/sdk/v2/client"
import { cmp, normalizeProviderList } from "@/context/global-sync/utils"
import { queryKeys } from "./keys"
import { createHttpShellBackend } from "../data/http-backend"

type ProjectClient = {
  project: {
    list: () => Promise<{ data?: Project[] }>
  }
}

type ProviderClient = {
  provider: {
    list: () => Promise<{ data?: ProviderListResponse }>
  }
}

type CommandClient = {
  command: {
    list: () => Promise<{ data?: Command[] }>
  }
}

export function normalizeProjectList(data: Project[] | undefined) {
  return (data ?? [])
    .filter((item) => !!item?.id)
    .filter((item) => !!item.worktree && !item.worktree.includes("opencode-test"))
    .slice()
    .sort((a, b) => cmp(a.id, b.id))
}

export function projectListQuery(input: {
  baseUrl?: string
  client: ProjectClient
}) {
  const backend = createHttpShellBackend({
    client: input.client,
  })
  return {
    queryKey: queryKeys.shell.projects(input.baseUrl),
    staleTime: 60 * 1000,
    queryFn: async () => normalizeProjectList(await backend.listProjects()),
  }
}

export function providerListQuery(input: {
  baseUrl?: string
  client: ProviderClient
}) {
  const backend = createHttpShellBackend({
    client: input.client as ProjectClient & ProviderClient & CommandClient,
  })
  return {
    queryKey: queryKeys.shell.providers(input.baseUrl),
    staleTime: 60 * 1000,
    queryFn: async () => normalizeProviderList((await backend.listProviders()) ?? { all: [], connected: [], default: {} }),
  }
}

export function normalizeCommandList(data: Command[] | undefined) {
  return (data ?? [])
    .filter((item) => !!item?.name)
    .slice()
    .sort((a, b) => cmp(a.name, b.name))
}

export function commandListQuery(input: {
  baseUrl?: string
  directory: string
  client: CommandClient
}) {
  const backend = createHttpShellBackend({
    client: input.client as ProjectClient & ProviderClient & CommandClient,
  })
  return {
    queryKey: queryKeys.shell.commands(input.baseUrl, input.directory),
    staleTime: 30 * 1000,
    queryFn: async () => normalizeCommandList(await backend.listCommands({ directory: input.directory })),
  }
}
