import { ServerError, type EnabledAppPlugin, type FetchQuery, type LivePlugin, type Server } from "@/server"

export type PluginServerCalls = {
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>
  readonly operation: (name: string, input: unknown) => Promise<unknown>
  readonly backendFetch: (pluginId: string, path: string, init?: RequestInit) => Promise<Response>
  readonly livePlugins: () => FetchQuery<readonly LivePlugin[]>
  readonly liveBundle: (pluginId: string, hash: string) => Promise<string>
  readonly removeLive: (pluginId: string) => Promise<void>
  readonly installedPlugins: () => FetchQuery<readonly EnabledAppPlugin[]>
  readonly installedBundle: (pluginId: string, sha256: string) => Promise<Uint8Array<ArrayBuffer>>
}

function signedAppPlugins(server: Server) {
  if (!server.appPlugins) throw new ServerError({ class: "auth", message: "App plugins need a signed account" })
  return server.appPlugins
}

export function pluginServerCalls(server: Server): PluginServerCalls {
  return {
    fetch: (path, init) => server.request(path, init),
    operation: (name, input) => server.operation(name, input),
    backendFetch: (pluginId, path, init) => signedAppPlugins(server).backendFetch(pluginId, path, init),
    livePlugins: () => server.queries.livePlugins.list(),
    liveBundle: (pluginId, hash) => server.livePlugins.bundle(pluginId, hash),
    removeLive: (pluginId) => server.livePlugins.remove(pluginId),
    installedPlugins: () => server.queries.appPlugins.enabled(),
    installedBundle: (pluginId, sha256) => signedAppPlugins(server).bundle(pluginId, sha256),
  }
}
