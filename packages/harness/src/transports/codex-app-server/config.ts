import type { ConfigOperations, DraftLaunch, HarnessSession, StartInput } from "../../contract"
import { applySessionConfigUpdate, configOptionsPreview } from "../../contract"
import { codexModelOptions, type CodexModel } from "./models"
import { codexModeState, requireCodexMode } from "./modes"

type ConfigEntry = { start: StartInput }

export function createCodexConfig<T extends ConfigEntry>(input: {
  entry(session: HarnessSession): T
  models(entry: T): Promise<CodexModel[]>
  probe(draft: DraftLaunch, mode: "probe" | "peek"): Promise<CodexModel[]>
}): ConfigOperations {
  return {
    options: async (target, mode) => {
      if ("session" in target) {
        const entry = input.entry(target.session)
        return configOptionsPreview(codexModelOptions(await input.models(entry), target.model?.modelID ?? entry.start.config.model?.modelID))
      }
      return configOptionsPreview(codexModelOptions(await input.probe(target.draft, mode), target.draft.config.model?.modelID))
    },
    permissionModes: async (target) => codexModeState("session" in target
      ? input.entry(target.session).start.config.permissionMode : target.draft.config.permissionMode),
    setPermissionMode: async (session, modeId) => {
      const entry = input.entry(session)
      entry.start = { ...entry.start, config: applySessionConfigUpdate(entry.start.config, { permissionMode: requireCodexMode(modeId) }) }
      return codexModeState(entry.start.config.permissionMode)
    },
  }
}
