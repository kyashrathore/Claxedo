import type { SessionConfig, SessionConfigUpdate } from "@claxedo/agent-runtime-contract"
import type { ConfigOperations, ConfigOptionsPreview, ConfigPreviewTarget, ConfigTarget, HarnessSession } from "../../contract"
import { configOptionsPreview, modelAndEffortOptions } from "../../contract"
import { TransportError } from "../../contract/errors.js"
import type { Entry } from "./entry.js"
import type { ModelEntry } from "./catalog-port.js"
import type { WorkspaceScope } from "./scope.js"

export type OpenCodeConfigHost = {
  entry(session: HarnessSession): Entry
  targetScope(target: ConfigTarget): WorkspaceScope
  models(scope: WorkspaceScope): Promise<readonly ModelEntry[]>
}

function mergedConfig(previous: SessionConfig, update: SessionConfigUpdate): SessionConfig {
  return {
    ...previous,
    ...(update.harness !== undefined ? { harness: update.harness } : {}),
    ...(update.permissionCeiling !== undefined ? { permissionCeiling: update.permissionCeiling } : {}),
    ...(update.permissionMode !== undefined ? { permissionMode: update.permissionMode ?? undefined } : {}),
    ...(update.permissionState !== undefined ? { permissionState: update.permissionState ?? undefined } : {}),
    ...(update.model !== undefined ? { model: update.model ?? undefined } : {}),
    ...(update.variant !== undefined ? { variant: update.variant ?? undefined } : {}),
    ...(update.agent !== undefined ? { agent: update.agent ?? undefined } : {}),
    ...(update.instructions !== undefined ? { instructions: update.instructions ?? undefined } : {}),
    ...(update.group !== undefined ? { group: update.group ?? undefined } : {}),
    ...(update.handoff !== undefined ? { handoff: update.handoff ?? undefined } : {}),
  }
}

export function openCodeConfigOperations(host: OpenCodeConfigHost): ConfigOperations {
  return {
    read: async (session: HarnessSession): Promise<SessionConfig> => host.entry(session).start.config,
    update: async (session: HarnessSession, update: SessionConfigUpdate): Promise<SessionConfig> => {
      const entry = host.entry(session)
      const next = mergedConfig(entry.start.config, update)
      entry.start = { ...entry.start, config: next }
      return next
    },
    options: async (target: ConfigPreviewTarget): Promise<ConfigOptionsPreview> => {
      const models = await host.models(host.targetScope(target))
      const current = "session" in target ? target.model ?? host.entry(target.session).start.config.model : target.draft.config.model
      return configOptionsPreview(modelAndEffortOptions({
        models: models.map((model) => ({ id: `${model.providerID}/${model.id}`, name: model.name ?? model.id })),
        ...(current ? { selected: `${current.providerID}/${current.modelID}` } : {}),
      }))
    },
    permissionModes: async () => ({ modes: [], unsupported: "OpenCode does not expose a session permission mode", appliesFrom: "next-turn" as const }),
    setPermissionMode: async () => { throw new TransportError("opencode", "configuration", "OpenCode does not expose a session permission mode") },
  }
}
