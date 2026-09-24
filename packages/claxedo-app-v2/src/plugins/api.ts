export type PluginServerCalls = {
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>
  readonly operation: (name: string, input: unknown) => Promise<unknown>
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
    removeLive: () => Promise.reject(new AdapterGapError("plugins.removeLive")),
  }
}
