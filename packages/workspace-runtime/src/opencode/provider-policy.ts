import type { Plugin } from "@opencode-ai/plugin"
import type { OpenCodeHost } from "./host"
import type { WorkspaceScope } from "./scope"

/**
 * The provider configuration of ONE harness inside this workspace.
 *
 * A `config`-sourced provider row exists because the harness's own config
 * declares it, so the only way to disconnect it is to name it in that config's
 * `disabled_providers`. That document belongs to (this workspace, the OpenCode
 * harness); the SDK's provider-policy plugin below persists it and enforces it
 * in the engine's catalog.
 */
export type ProviderConfigStore = {
  /** The harness's current configuration document. */
  read(): Promise<Record<string, unknown>>
  /**
   * Merge `patch` into it and settle whatever caches the catalog is derived
   * from, so the next catalog read reflects the new list.
   */
  write(patch: { disabled_providers: string[] }): Promise<Record<string, unknown>>
}

/** Workspace provider selection is enforced in the engine's catalog, not only
 * filtered out of the picker. Plugin storage survives SDK/process restart. */
export function createProviderPolicy() {
  const stores = new Map<string, ProviderConfigStore>()
  const plugin: Plugin.Plugin = {
    id: "claxedo-provider-policy",
    async setup(context) {
      const key = `disabled-providers:${context.location.directory}`
      const saved = await context.storage.get(key)
      if (saved !== undefined && (!Array.isArray(saved) || saved.some((id) => typeof id !== "string"))) {
        throw new Error("Invalid persisted OpenCode provider policy")
      }
      let disabled = (saved ?? []) as string[]
      let pending = Promise.resolve()
      await context.catalog.transform((draft) => {
        // Config/model plugins may declare their rows after this transform.
        // Activation is the SDK's authoritative availability switch and
        // survives those overlays; deleting an early draft row does not.
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
            // Failure is returned to the caller; retry reloads the persisted
            // policy. Never acknowledge a write with a stale engine catalog.
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
      await (await host.client()).model.list({ location: { directory: scope.directory } })
      const store = stores.get(scope.directory)
      if (!store) throw new Error("OpenCode provider policy was not initialized for the workspace")
      return store
    },
  }
}
