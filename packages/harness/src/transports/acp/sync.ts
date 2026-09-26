import type { SessionConfigOption } from "@agentclientprotocol/sdk"
import type { AgentPermissionModeState, PromptModel, SessionConfig } from "@claxedo/agent-runtime-contract"
import type { TurnInput } from "../../contract"
import { AcpTransportError } from "./errors"
import type { AcpEntry } from "./index"
import { acpMatchChoice, acpOptionValue, acpPermissionModes, acpPickOption, acpSelectChoices, type AcpOptionKind } from "./options"

function modelIds(model: PromptModel, effort: string | undefined): string[] {
  const base = `${model.providerID}/${model.modelID}`
  return [...new Set([...(effort ? [`${base}/${effort}`] : []), base, ...(effort ? [`${model.modelID}/${effort}`] : []), model.modelID])]
}

async function acpSetOption(entry: AcpEntry, option: SessionConfigOption, value: string, kind: AcpOptionKind): Promise<void> {
  const response = await entry.peer.agent.setSessionConfigOption({ sessionId: entry.session.binding.upstreamSessionId, configId: option.id, value })
  entry.options = response.configOptions
  const kept = acpOptionValue(acpPickOption(entry.options, kind))
  if (kept !== undefined && kept !== value) {
    throw new AcpTransportError("configuration", `ACP agent kept ${kind === "thought_level" ? "effort" : kind} ${kept} instead of ${value}`)
  }
}

export async function acpSetPermissionMode(entry: AcpEntry, modeId: string): Promise<AgentPermissionModeState> {
  const option = acpPickOption(entry.options, "mode")
  if (option) {
    if (!acpMatchChoice(option, [modeId])) throw new AcpTransportError("configuration", `ACP agent does not offer permission mode ${modeId}`)
    if (acpOptionValue(option) !== modeId) await acpSetOption(entry, option, modeId, "mode")
    return acpPermissionModes(entry)
  }
  if (!entry.modes.some((mode) => mode.id === modeId)) throw new AcpTransportError("configuration", `ACP agent does not offer permission mode ${modeId}`)
  await setMode(entry, modeId)
  return acpPermissionModes(entry)
}

async function setMode(entry: AcpEntry, modeId: string): Promise<void> {
  const seen = entry.modeUpdates
  await entry.peer.agent.setSessionMode({ sessionId: entry.session.binding.upstreamSessionId, modeId })
  if (entry.modeUpdates === seen) entry.currentModeId = modeId
}

async function applyAgent(entry: AcpEntry, agent: string): Promise<void> {
  const option = acpPickOption(entry.options, "mode")
  const wanted = acpMatchChoice(option, [agent])
  if (wanted) {
    if (acpOptionValue(option) !== wanted) await acpSetOption(entry, option!, wanted, "mode")
    return
  }
  const mode = entry.modes.find((item) => item.id === agent || item.id === agent.toLowerCase())
  if (mode && entry.currentModeId !== mode.id) await setMode(entry, mode.id)
}

function resolvedModelId(entry: AcpEntry): string | undefined {
  return acpOptionValue(acpPickOption(entry.options, "model"))
}

async function applyModel(entry: AcpEntry, model: PromptModel | undefined, effort: string | undefined): Promise<boolean> {
  if (!model) return false
  const option = acpPickOption(entry.options, "model")
  const wanted = acpMatchChoice(option, modelIds(model, effort))
  if (wanted) {
    if (acpOptionValue(option) !== wanted) await acpSetOption(entry, option!, wanted, "model")
    return !!effort && wanted.endsWith(`/${effort}`)
  }
  if (model.modelID === "default" || model.modelID === resolvedModelId(entry)) return false
  throw new AcpTransportError("configuration", option
    ? `ACP agent does not offer model ${model.modelID}`
    : "ACP agent owns model selection and does not advertise a model selector")
}

async function applyEffort(entry: AcpEntry, effort: string | undefined): Promise<void> {
  if (!effort) return
  const option = acpPickOption(entry.options, "thought_level")
  const wanted = acpMatchChoice(option, [effort, effort.toLowerCase()])
  if (!wanted) {
    const offered = option ? acpSelectChoices(option).map((choice) => choice.id) : []
    throw new AcpTransportError("configuration", offered.length
      ? `ACP agent does not offer effort ${effort}; it offers ${offered.join(", ")}`
      : `ACP agent offers no effort control, so effort ${effort} cannot be applied`)
  }
  if (acpOptionValue(option) !== wanted) await acpSetOption(entry, option!, wanted, "thought_level")
}

export async function acpApplyTurnConfig(entry: AcpEntry, turn: TurnInput): Promise<void> {
  const mode = turn.prompt.permissionMode
  if (mode) {
    const applied = await acpSetPermissionMode(entry, mode)
    if (applied.currentModeId !== mode) throw new AcpTransportError("configuration", `ACP kept permission mode ${applied.currentModeId ?? "unknown"} instead of ${mode}`)
  }
  const effort = turn.effort ?? undefined
  const effortInModel = await applyModel(entry, turn.model, effort)
  if (!effortInModel) await applyEffort(entry, effort)
}

export async function acpApplySessionConfig(entry: AcpEntry, config: SessionConfig): Promise<void> {
  if (config.agent) await applyAgent(entry, config.agent)
  const effort = config.variant ?? undefined
  const effortInModel = await applyModel(entry, config.model, effort)
  if (!effortInModel) await applyEffort(entry, effort)
}
