import type { ConfigOperations, ConfigOptionsPreview, ConfigPreviewTarget, ConfigTarget, HarnessSession } from "../../contract"
import { configOptionsPreview, modelAndEffortOptions } from "../../contract"
import { TransportError } from "../../contract/errors.js"
import type { Entry } from "./entry.js"
import type { ModelEntry } from "./catalog-port.js"
import type { WorkspaceScope } from "./scope.js"

export type OpenCodeConfigHost = {
  entry(session: HarnessSession): Entry
  targetScope(target: ConfigTarget): WorkspaceScope
  models(scope: WorkspaceScope, target: ConfigPreviewTarget): Promise<readonly ModelEntry[]>
}

export function openCodeConfigOperations(host: OpenCodeConfigHost): ConfigOperations {
  return {
    options: async (target: ConfigPreviewTarget): Promise<ConfigOptionsPreview> => {
      const models = await host.models(host.targetScope(target), target)
      const current = "session" in target ? target.model : target.draft.model
      return configOptionsPreview(modelAndEffortOptions({
        models: models.map((model) => ({ id: `${model.providerID}/${model.id}`, name: model.name ?? model.id })),
        ...(current ? { selected: `${current.providerID}/${current.modelID}` } : {}),
      }))
    },
    permissionModes: async () => ({ modes: [], unsupported: "OpenCode does not expose a session permission mode", appliesFrom: "next-turn" as const }),
    setPermissionMode: async () => { throw new TransportError("opencode", "configuration", "OpenCode does not expose a session permission mode") },
  }
}
