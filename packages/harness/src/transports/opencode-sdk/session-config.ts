import type { ConfigOperations, ConfigOptionsPreview, ConfigPreviewTarget, ConfigTarget, HarnessSession } from "../../contract"
import { configOptionsPreview, modelAndEffortOptions } from "../../contract"
import { TransportError } from "../../contract/errors.js"
import type { Entry } from "./entry.js"
import type { ModelEntry } from "./catalog-port.js"
import type { WorkspaceScope } from "./scope.js"
import { assertProviderAvailable } from "./credentials"
import type { OpenCodeSessionPort } from "./session-types"

export type OpenCodeConfigHost = {
  entry(session: HarnessSession): Entry
  targetScope(target: ConfigTarget): WorkspaceScope
  models(scope: WorkspaceScope, target: ConfigPreviewTarget): Promise<readonly ModelEntry[]>
  switchModel: OpenCodeSessionPort["switchModel"]
}

export function openCodeConfigOperations(host: OpenCodeConfigHost): ConfigOperations {
  return {
    setModelSettings: async (session, settings) => {
      const entry = host.entry(session)
      const model = settings.model
      if (!model) throw new TransportError("opencode", "configuration", "OpenCode requires a model")
      assertProviderAvailable(entry.start, model.providerID)
      const models = await host.models(entry.scope, { session, model })
      const selected = models.find((row) => row.providerID === model.providerID && row.id === model.modelID)
      if (!selected) throw new TransportError("opencode", "configuration", `OpenCode does not offer model ${model.modelID}`)
      if (settings.effort && !selected.variants?.includes(settings.effort)) {
        throw new TransportError("opencode", "configuration", `OpenCode does not offer effort ${settings.effort} for this model`)
      }
      await host.switchModel(entry.scope, entry.upstream, { ...model, ...(settings.effort ? { variant: settings.effort } : {}) })
    },
    options: async (target: ConfigPreviewTarget): Promise<ConfigOptionsPreview> => {
      const models = await host.models(host.targetScope(target), target)
      const current = "session" in target ? target.model : target.draft.model
      const selected = models.find((model) => model.providerID === current?.providerID && model.id === current.modelID)
      return configOptionsPreview(modelAndEffortOptions({
        models: models.map((model) => ({ id: `${model.providerID}/${model.id}`, name: model.name ?? model.id })),
        ...(current ? { selected: `${current.providerID}/${current.modelID}` } : {}),
        efforts: selected?.variants,
      }))
    },
    permissionModes: async () => ({ modes: [], unsupported: "OpenCode does not expose a session permission mode", appliesFrom: "next-turn" as const }),
    setPermissionMode: async () => { throw new TransportError("opencode", "configuration", "OpenCode does not expose a session permission mode") },
  }
}
