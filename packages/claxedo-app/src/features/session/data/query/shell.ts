import type { Command } from "@opencode-ai/sdk/v2/client"
import { queryKeys } from "@/platform/query/keys"
import { createHttpShellBackend } from "@/platform/query/control-plane"
import { workspaceResolveQuery, type WorkspaceRuntimeSnapshot } from "@/platform/runtime/workspace-query"
import { cmp } from "@/platform/query/sort"
import { normalizeUrl } from "@/platform/api/api"
import { workspaceScopedResourceList } from "@/platform/runtime/agent-config-routes"

type CommandClient = {
  command: {
    list: () => Promise<{ data?: Command[] }>
  }
}

export function normalizeCommandList(data: unknown) {
  const list = Array.isArray(data)
    ? data
    : data && typeof data === "object" && "data" in data && Array.isArray(data.data)
    ? data.data
    : data && typeof data === "object" && "commands" in data && Array.isArray(data.commands)
    ? data.commands
    : []
  return list
    .filter((item): item is Command => !!item && typeof item === "object" && "name" in item && typeof item.name === "string")
    .filter((item) => !!item?.name)
    .slice()
    .sort((a, b) => cmp(a.name, b.name))
}

function commandListFromUnknown(data: unknown) {
  return normalizeCommandList(data)
}

export function commandListQuery(input: {
  baseUrl?: string
  directory: string
  request?: typeof fetch
  workspace?: WorkspaceRuntimeSnapshot | null
  client: CommandClient
}) {
  const backend = createHttpShellBackend({
    client: input.client,
  })
  return {
    queryKey: queryKeys.shell.commands(input.baseUrl, input.directory),
    staleTime: 30 * 1000,
    queryFn: async () => {
      if (input.request && input.baseUrl) {
        const workspace = input.workspace !== undefined
          ? input.workspace
          : await workspaceResolveQuery({ baseUrl: input.baseUrl, request: input.request, directory: input.directory }).queryFn()
        const baseUrl = normalizeUrl(input.baseUrl) ?? input.baseUrl
        return workspaceScopedResourceList({
          baseUrl,
          directory: input.directory,
          request: input.request,
          workspace,
          resource: { plural: "commands", singular: "command", scopeCentralUrl: false },
          parse: commandListFromUnknown,
        })
      }
      return normalizeCommandList(await backend.listCommands({ directory: input.directory }))
    },
  }
}
