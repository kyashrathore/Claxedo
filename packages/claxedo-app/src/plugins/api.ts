import type { FetchQuery, LivePlugin, Server } from "@/server"

export type PluginServerCalls = {
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>
  readonly operation: (name: string, input: unknown) => Promise<unknown>
  readonly livePlugins: () => FetchQuery<readonly LivePlugin[]>
  readonly liveBundle: (pluginId: string, hash: string) => Promise<string>
  readonly removeLive: (pluginId: string) => Promise<void>
}

export function pluginServerCalls(server: Server): PluginServerCalls {
  return {
    fetch: (path, init) => server.request(path, init),
    operation: (name, input) => server.operation(name, input),
    livePlugins: () => server.queries.livePlugins.list(),
    liveBundle: (pluginId, hash) => server.livePlugins.bundle(pluginId, hash),
    removeLive: (pluginId) => server.livePlugins.remove(pluginId),
  }
}
