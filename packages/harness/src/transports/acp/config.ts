import type { ConfigOperations, DraftLaunch, HarnessSession } from "../../contract"
import { configOptionsPreview } from "../../contract"
import type { SessionConfig } from "@claxedo/agent-runtime-contract"
import type { AcpEntry } from "./index"
import { acpOption, acpPermissionModes, type AcpCatalog } from "./options"
import { acpApplySessionConfig, acpSetPermissionMode } from "./sync"

export function acpConfig(entryFor: (session: HarnessSession) => AcpEntry,
  probe: (draft: DraftLaunch, mode: "probe" | "peek") => Promise<AcpCatalog>): ConfigOperations {
  return {
    read: async (session) => entryFor(session).start.config,
    update: async (session, update) => {
      const entry = entryFor(session)
      const config: SessionConfig = { ...entry.start.config,
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
      await acpApplySessionConfig(entry, config)
      entry.start = { ...entry.start, config }
      return entry.start.config
    },
    options: async (target, mode) => {
      const catalog = "session" in target ? entryFor(target.session) : await probe(target.draft, mode)
      return configOptionsPreview(catalog.options.map(acpOption))
    },
    permissionModes: async (target) => acpPermissionModes("session" in target ? entryFor(target.session) : await probe(target.draft, "probe")),
    setPermissionMode: (session, modeId) => acpSetPermissionMode(entryFor(session), modeId),
  }
}
