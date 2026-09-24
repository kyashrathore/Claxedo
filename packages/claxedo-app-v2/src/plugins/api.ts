import type { FetchQuery } from "@/server"

export type LivePlugin = {
  readonly id: string
  readonly name: string | null
  readonly version: string | null
  readonly status: "building" | "ready" | "failed"
  readonly hash: string | null
  readonly lastError: string | null
}

export type PluginServerCalls = {
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>
  readonly operation: (name: string, input: unknown) => Promise<unknown>
  readonly livePlugins: () => FetchQuery<readonly LivePlugin[]> | undefined
  readonly liveBundle: (pluginId: string, hash: string) => Promise<string>
  readonly removeLive: (pluginId: string) => Promise<void>
}

export class AdapterGapError extends Error {
  constructor(readonly member: string) {
    super(`The server adapter does not provide ${member} yet`)
    this.name = "AdapterGapError"
  }
}

export function pluginServerCalls(): PluginServerCalls {
  return {
    fetch: () => Promise.reject(new AdapterGapError("plugins.fetch")),
    operation: () => Promise.reject(new AdapterGapError("plugins.operation")),
    livePlugins: () => undefined,
    liveBundle: () => Promise.reject(new AdapterGapError("plugins.liveBundle")),
    removeLive: () => Promise.reject(new AdapterGapError("plugins.removeLive")),
  }
}
