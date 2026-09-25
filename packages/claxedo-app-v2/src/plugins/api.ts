import type { FetchQuery, LivePlugin, Server } from "@/server"

export type PluginServerCalls = {
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>
  readonly operation: (name: string, input: unknown) => Promise<unknown>
  readonly livePlugins: () => FetchQuery<readonly LivePlugin[]>
  readonly liveBundle: (pluginId: string, hash: string) => Promise<string>
  readonly removeLive: (pluginId: string) => Promise<void>
}

export class AdapterGapError extends Error {
  constructor(readonly member: string) {
    super(`The server adapter does not provide ${member} yet`)
    this.name = "AdapterGapError"
  }
}

export function pluginServerCalls(server: Server): PluginServerCalls {
  return {
    fetch: (path, init) => server.request(path, init),
    operation: () => Promise.reject(new AdapterGapError("plugins.operation")),
    livePlugins: () => server.queries.livePlugins.list(),
    liveBundle: (pluginId, hash) => server.livePlugins.bundle(pluginId, hash),
    removeLive: (pluginId) => server.livePlugins.remove(pluginId),
  }
}
