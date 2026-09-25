import type { ConfigOperations, DraftLaunch, HarnessSession, StartInput } from "../../contract"
import { CodexTransportError } from "./errors"
import { codexModelOptions, type CodexModel } from "./models"

type ConfigEntry = { start: StartInput }

export function createCodexConfig<T extends ConfigEntry>(input: {
  entry(session: HarnessSession): T
  models(entry: T): Promise<CodexModel[]>
  probe(draft: DraftLaunch, mode: "probe" | "peek"): Promise<CodexModel[]>
}): ConfigOperations {
  return {
    read: async (session) => input.entry(session).start.config,
    update: async (session, update) => {
      const entry = input.entry(session)
      entry.start = { ...entry.start, config: { ...entry.start.config,
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
      } }
      return entry.start.config
    },
    options: async (target, mode) => {
      if ("session" in target) {
        const entry = input.entry(target.session)
        return codexModelOptions(await input.models(entry), entry.start.config.model?.modelID)
      }
      return codexModelOptions(await input.probe(target.draft, mode), target.draft.config.model?.modelID)
    },
    permissionModes: async () => ({ modes: [], unsupported: "Codex permission modes are selected per turn", appliesFrom: "next-turn" }),
    setPermissionMode: async () => { throw new CodexTransportError("configuration", "Codex permission modes are selected per turn") },
  }
}
