import type { SessionConfigOption, SessionMode, SessionModeState } from "@agentclientprotocol/sdk"
import type { AgentAgent, AgentConfigOption, AgentPermissionModeState, HarnessEffortLevels, ModelSelection } from "@claxedo/agent-runtime-contract"

export type AcpOptionKind = "mode" | "model" | "thought_level"

export type AcpChoice = { id: string; name: string; description?: string }

export type AcpCatalog = {
  options: SessionConfigOption[]
  modes: SessionMode[]
  currentModeId?: string
}

export function acpSelectChoices(option: SessionConfigOption): AcpChoice[] {
  if (option.type !== "select") return []
  return option.options.flatMap((item) => "value" in item
    ? [{ id: item.value, name: item.name, ...(item.description ? { description: item.description } : {}) }]
    : item.options.map((value) => ({ id: value.value, name: value.name, ...(value.description ? { description: value.description } : {}) })))
}

export function acpOption(option: SessionConfigOption): AgentConfigOption {
  const { id, name, type, category, currentValue, description } = option
  return { id, name, type, ...(category ? { category } : {}), currentValue, ...(description ? { description } : {}),
    ...(type === "select" ? { selectOptions: acpSelectChoices(option) } : {}) }
}

export function acpPickOption(options: readonly SessionConfigOption[], kind: AcpOptionKind): SessionConfigOption | undefined {
  return options.find((option) => option.type === "select" && (option.category === kind || option.id === kind))
}

export function acpOptionValue(option: SessionConfigOption | undefined): string | undefined {
  return option?.type === "select" && typeof option.currentValue === "string" ? option.currentValue : undefined
}

export function acpMatchChoice(option: SessionConfigOption | undefined, ids: readonly string[]): string | undefined {
  if (!option) return undefined
  const offered = new Set(acpSelectChoices(option).map((choice) => choice.id))
  return ids.find((id) => offered.has(id))
}

export function acpModeState(state: SessionModeState | null | undefined): Pick<AcpCatalog, "modes" | "currentModeId"> {
  if (!state) return { modes: [] }
  return { modes: state.availableModes.map((mode) => ({ id: mode.id, name: mode.name, ...(mode.description ? { description: mode.description } : {}) })),
    ...(state.currentModeId ? { currentModeId: state.currentModeId } : {}) }
}

export function acpPermissionModes(catalog: AcpCatalog): AgentPermissionModeState {
  const option = acpPickOption(catalog.options, "mode")
  if (option) {
    const current = acpOptionValue(option)
    return { modes: acpSelectChoices(option), ...(current ? { currentModeId: current } : {}), appliesFrom: "next-turn" }
  }
  if (catalog.modes.length) {
    return { modes: catalog.modes.map((mode) => ({ ...mode, description: mode.description ?? undefined })),
      ...(catalog.currentModeId ? { currentModeId: catalog.currentModeId } : {}), appliesFrom: "next-turn" }
  }
  return { modes: [], ...(catalog.options.length ? {} : { unsupported: "This agent does not expose permission modes" }), appliesFrom: "next-turn" }
}

export function acpAgents(catalog: AcpCatalog): AgentAgent[] {
  const option = acpPickOption(catalog.options, "mode")
  const choices = option ? acpSelectChoices(option) : catalog.modes.map((mode) => ({ id: mode.id, name: mode.name }))
  return choices.map((choice) => ({ name: choice.id, description: choice.name, mode: "primary" }))
}

export function acpModelSelection(catalog: AcpCatalog | undefined): ModelSelection {
  if (!catalog || !catalog.options.length) return { status: "optional" }
  return { status: acpPickOption(catalog.options, "model") ? "optional" : "unsupported" }
}

export function acpEffortCatalog(catalog: AcpCatalog | undefined): HarnessEffortLevels {
  if (!catalog || !catalog.options.length) return { status: "unresolved", models: [] }
  const effort = acpPickOption(catalog.options, "thought_level")
  if (!effort) return { status: "unsupported", models: [] }
  const modelID = acpOptionValue(acpPickOption(catalog.options, "model"))
  const levels = acpSelectChoices(effort).map((choice) => choice.id)
  return { status: "unresolved", models: modelID ? [{ modelID, levels }] : [] }
}
