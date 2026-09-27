import type { ConfigOperations, DraftLaunch, HarnessSession } from "../../contract"
import { applySessionConfigUpdate, configOptionsPreview } from "../../contract"
import type { AcpEntry } from "./index"
import { acpOption, acpPermissionModes, type AcpCatalog } from "./options"
import { acpApplySessionConfig, acpSetPermissionMode } from "./sync"

export function acpConfig(entryFor: (session: HarnessSession) => AcpEntry,
  probe: (draft: DraftLaunch, mode: "probe" | "peek") => Promise<AcpCatalog>): ConfigOperations {
  return {
    read: async (session) => entryFor(session).start.config,
    update: async (session, update) => {
      const entry = entryFor(session)
      const config = applySessionConfigUpdate(entry.start.config, update)
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
