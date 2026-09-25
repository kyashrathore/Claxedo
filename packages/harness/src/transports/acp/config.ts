import type { ConfigOperations, DraftLaunch, HarnessSession } from "../../contract"
import type { SessionConfig } from "@claxedo/agent-runtime-contract"
import type { AcpEntry } from "./index"

export function acpConfig(entryFor: (session: HarnessSession) => AcpEntry,
  probe: (draft: DraftLaunch, mode: "probe" | "peek") => Promise<AcpEntry["options"]>): ConfigOperations {
  const operations: ConfigOperations = {
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
      entry.start = { ...entry.start, config }
      return entry.start.config
    },
    options: async (target, mode) => {
      const options = "session" in target ? entryFor(target.session).options : await probe(target.draft, mode)
      return options.map(({ id, name, type, category, currentValue, description }) => ({ id, name, type,
        ...(category ? { category } : {}), currentValue, ...(description ? { description } : {}) }))
    },
    permissionModes: async (target) => {
      const options = "session" in target ? entryFor(target.session).options : await probe(target.draft, "probe")
      return { appliesFrom: "next-turn", modes: options.filter((option) => option.category === "mode").flatMap((option) =>
        option.type === "select" ? option.options.flatMap((item) => "value" in item ? [{ id: item.value, name: item.name }] : item.options.map((value) => ({ id: value.value, name: value.name }))) : []) }
    },
    setPermissionMode: async (session, modeId) => {
      const entry = entryFor(session)
      await entry.peer.agent.setSessionMode({ sessionId: session.binding.upstreamSessionId, modeId })
      return operations.permissionModes({ session })
    },
  }
  return operations
}
