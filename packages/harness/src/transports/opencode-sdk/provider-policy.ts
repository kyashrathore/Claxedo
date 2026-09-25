import type { Plugin } from "@opencode-ai/plugin"
import { openCodeLocationClient, type OpenCodeHost } from "./host"
import type { WorkspaceScope } from "./scope"
import { arr } from "./value"

export type ProviderConfigStore = {
  
  read(): Promise<Record<string, unknown>>
  
  write(patch: { disabled_providers: string[] }): Promise<Record<string, unknown>>
}

export function createProviderPolicy() {
  const stores = new Map<string, ProviderConfigStore>()
  const plugin: Plugin.Plugin = {
    id: "claxedo-provider-policy",
    async setup(context) {
      const key = `disabled-providers:${context.location.directory}`
      const raw = await context.storage.get(key)
      const saved = arr(raw)
      if (raw !== undefined && !saved?.every((id) => typeof id === "string")) {
        throw new Error("Invalid persisted OpenCode provider policy")
      }
      let disabled: string[] = saved?.filter((id): id is string => typeof id === "string") ?? []
      let pending = Promise.resolve()
      await context.catalog.transform((draft) => {
        for (const id of disabled) draft.provider.update(id, (provider) => { provider.activation = "disabled" })
      })
      const store: ProviderConfigStore = {
        async read() {
          await pending
          return { disabled_providers: [...disabled] }
        },
        async write(patch) {
          const next = [...new Set(patch.disabled_providers)]
          const operation = pending.then(async () => {
            await context.storage.set(key, next)
            disabled = next
            await context.catalog.reload()
          })
          pending = operation.catch(() => {})
          await operation
          return { disabled_providers: [...disabled] }
        },
      }
      stores.set(context.location.directory, store)
      return () => { if (stores.get(context.location.directory) === store) stores.delete(context.location.directory) }
    },
  }
  return {
    plugin,
    async store(host: OpenCodeHost, scope: WorkspaceScope): Promise<ProviderConfigStore> {
      await openCodeLocationClient(host, scope.directory)
      const store = stores.get(scope.directory)
      if (!store) throw new Error("OpenCode provider policy was not initialized for the workspace")
      return store
    },
  }
}
