import type { Plugin } from "@opencode-ai/plugin"

/** A provider the engine has no row for until Claxedo declares one: an OpenAI-compatible endpoint and its models. */
export type ProviderDefinition = Readonly<{
  id: string
  name: string
  baseURL: string
  headers: Readonly<Record<string, string>>
  models: Readonly<Record<string, Readonly<{ name: string }>>>
  /** Environment variables the engine reads the provider's key from. */
  env: readonly string[]
  /** Declared but off when no key source can serve it, so the engine does not list its models. */
  enabled: boolean
}>

const OPENAI_COMPATIBLE_PACKAGE = "aisdk:@ai-sdk/openai-compatible"

/**
 * Declares providers to the engine the way its own config loader declares an
 * `opencode.json` provider: an integration carrying the env method, and a
 * catalog row with the package, endpoint, headers and models. A bound
 * provider's `baseURL` is the broker's in the end: the binding plugin moves its
 * transform last whenever another one overwrites it.
 */
export function createProviderDefinitionPolicy() {
  let definitions: readonly ProviderDefinition[] = []
  const locations = new Set<() => Promise<void>>()

  const plugin: Plugin.Plugin = {
    id: "claxedo-provider-definition",
    async setup(context) {
      const integration = await context.integration.transform((draft) => {
        for (const definition of definitions) {
          if (!definition.env.length) continue
          draft.method.update({ integrationID: definition.id, method: { type: "env", names: [...definition.env] } })
          draft.update(definition.id, (row) => { row.name = definition.name })
        }
      })
      const catalog = await context.catalog.transform((draft) => {
        for (const definition of definitions) {
          draft.provider.update(definition.id, (provider) => {
            provider.activation = definition.enabled ? "enabled" : "disabled"
            provider.name = definition.name
            provider.package = OPENAI_COMPATIBLE_PACKAGE
            provider.settings = { ...provider.settings, baseURL: definition.baseURL }
            provider.headers = { ...provider.headers, ...definition.headers }
          })
          for (const [modelID, model] of Object.entries(definition.models)) {
            draft.model.update(definition.id, modelID, (row) => { row.name = model.name })
          }
        }
      })
      const reload = async () => {
        await context.integration.reload()
        await context.catalog.reload()
      }
      locations.add(reload)
      return async () => {
        locations.delete(reload)
        await catalog.dispose()
        await integration.dispose()
      }
    },
  }

  return {
    plugin,
    /** Replace the declared set; a provider left out of it is no longer declared. */
    async apply(next: readonly ProviderDefinition[]) {
      definitions = next
      await Promise.all([...locations].map((reload) => reload()))
    },
  }
}
