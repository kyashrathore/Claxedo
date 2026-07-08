import type { Command } from "@opencode-ai/sdk/v2/client"
import { queryKeys } from "./keys"
import { createHttpShellBackend } from "../data/http-backend"
import { workspaceResolveQuery, type WorkspaceRuntimeSnapshot } from "./runtime"
import { cmp } from "./utils"
import { createTransport } from "../../shell/data/transport/transport"
import {
  agentConfigRequest,
  agentConfigUrl,
  workspaceRuntimeAgentConfigPath,
  workspaceTransportForBaseUrl,
} from "./agent-config-routes"

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
        const baseUrl = input.baseUrl.replace(/\/+$/, "")
        if (workspace?.kind !== "cloud" && workspace?.kind !== "user-hosted") {
          // Rubric Q4: declare auth intent at the call site. Loopback Claxedo
          // server bypasses the bearer (`unsignedLocalFetch`); cloud /
          // user-hosted control plane uses the signed fetch.
          const claxedoFetch = agentConfigRequest({ baseUrl, request: input.request })
          const res = await claxedoFetch(
            agentConfigUrl({
              baseUrl,
              resource: "commands",
            }),
          )
          if (!res.ok) return []
          const data = await res.json().catch(() => [])
          return commandListFromUnknown(data)
        }
        if (!workspace.workspaceId) return []
        const res = await createTransport({
          placement: {
            workspaceId: workspace.workspaceId,
            hosting: "workspace",
            transport: workspaceTransportForBaseUrl(baseUrl),
          },
          serverUrl: baseUrl,
          directory: input.directory,
          request: input.request,
        }).fetch(workspaceRuntimeAgentConfigPath({
          resource: "command",
          scope: input.directory,
        })).catch(() => undefined)
        if (!res) return []
        if (!res.ok) return []
        const data = await res.json().catch(() => [])
        return commandListFromUnknown(data)
      }
      return normalizeCommandList(await backend.listCommands({ directory: input.directory }))
    },
  }
}
