import type { Command, Project, ProviderAuthResponse, ProviderListResponse } from "@opencode-ai/sdk/v2/client"
import { queryKeys } from "@/platform/query/keys"
import { cmp } from "@/platform/query/sort"
import { normalizeProviderList } from "@/platform/query/provider-list"

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

export function createHttpShellBackend(input: {
  client: Partial<ProjectClient & ProviderClient & CommandClient>
}) {
  return {
    listProjects: async () => {
      if (!input.client.project) throw new Error("shell backend requires project client")
      return (await input.client.project.list()).data
    },
    listProviders: async () => {
      if (!input.client.provider) throw new Error("shell backend requires provider client")
      return (await input.client.provider.list()).data
    },
    listCommands: async (_input: { directory: string }) => {
      if (!input.client.command) throw new Error("shell backend requires command client")
      return (await input.client.command.list()).data
    },
  }
}

type ProviderAuthClient = {
  provider: {
    auth: () => Promise<{ data?: ProviderAuthResponse }>
  }
}

export function normalizeProjectList(data: Project[] | undefined) {
  return (data ?? [])
    .filter((item) => !!item?.id)
    .filter((item) => !!item.worktree)
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
    queryKey: queryKeys.controlPlane.projects(input.baseUrl),
    staleTime: 5 * 60 * 1000,
    queryFn: async () => normalizeProjectList(await backend.listProjects()),
  }
}

export function providerListQuery(input: {
  baseUrl?: string
  client: ProviderClient
}) {
  const backend = createHttpShellBackend({
    client: input.client,
  })
  return {
    queryKey: queryKeys.controlPlane.providers(input.baseUrl),
    staleTime: 5 * 60 * 1000,
    queryFn: async () => normalizeProviderList((await backend.listProviders()) ?? { all: [], connected: [], default: {} }),
  }
}

export function providerAuthQuery(input: {
  baseUrl?: string
  client: ProviderAuthClient
}) {
  return {
    queryKey: queryKeys.controlPlane.providerAuth(input.baseUrl),
    staleTime: 0,
    queryFn: async () => (await input.client.provider.auth()).data ?? {},
  }
}
