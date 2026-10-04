import { PI_PERMISSION_MODES, type AgentPermissionModeState, type PromptModel, type SessionConfig } from "@claxedo/agent-runtime-contract"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai"
import type { ModelRef } from "@earendil-works/pi-durable"
import { configOptionsPreview, modelAndEffortOptions, type ConfigOperations, type DraftLaunch, type HarnessSession,
  type ModelSettings } from "../../contract"
import { piPermissionMode } from "./approvals"
import { PiCredentials } from "./credentials"
import { piConfiguration, piDirectCredentialRequired } from "./errors"
import { piCatalog, sessionModelCatalog, type PiCatalogModel } from "./model-catalog"
import type { PiSession } from "./session"

export function piModelRef(model: PromptModel | undefined): ModelRef {
  const slash = model?.modelID.indexOf("/") ?? -1
  if (!model || model.providerID !== "pi" || slash < 1 || slash === model.modelID.length - 1) throw piConfiguration("Pi requires a provider/model key")
  return { provider: model.modelID.slice(0, slash), modelId: model.modelID.slice(slash + 1) }
}

export function piModel(credentials: PiCredentials, ref: ModelRef): Model<Api> {
  if (!credentials.direct(ref.provider)) throw piDirectCredentialRequired(ref.provider)
  const model = credentials.models.getModel(ref.provider, ref.modelId)
  if (!model) throw piConfiguration(`Pi does not offer model ${ref.provider}/${ref.modelId}`)
  return model
}

export function piThinkingLevel(model: Model<Api>, effort: string | null | undefined): ModelThinkingLevel | null | undefined {
  return thinkingLevel(`${model.provider}/${model.id}`, getSupportedThinkingLevels(model), effort)
}

function thinkingLevel(model: string, levels: readonly ModelThinkingLevel[], effort: string | null | undefined): ModelThinkingLevel | null | undefined {
  if (effort === null || effort === undefined) return effort
  const level = levels.find((candidate) => candidate === effort)
  if (!level) throw piConfiguration(`Pi does not run ${model} at thinking level ${effort}`)
  return level
}

export async function applyPiModelSettings(session: PiSession, settings: ModelSettings): Promise<void> {
  const ref = piModelRef(settings.model)
  const model = (await sessionModelCatalog(session.runtime)).find((row) => row.id === `${ref.provider}/${ref.modelId}`)
  if (!model) throw piConfiguration(`Pi does not offer model ${ref.provider}/${ref.modelId}`)
  const effort = thinkingLevel(model.id, model.efforts, settings.effort)
  await session.runtime.conversation.configure({ model: ref, ...(effort === undefined ? {} : { thinkingLevel: effort }) }, BACKGROUND_CONTEXT)
}

function permissionState(config: Pick<SessionConfig, "permissionMode" | "permissionCeiling">): AgentPermissionModeState {
  return { modes: [...PI_PERMISSION_MODES.modes], currentModeId: piPermissionMode(config), appliesFrom: PI_PERMISSION_MODES.appliesFrom }
}

type Target = { models: PiCatalogModel[]; model?: PromptModel; effort?: string }

async function sessionConfigTarget(session: PiSession, model: PromptModel | undefined): Promise<Target> {
  const agent = await session.runtime.conversation.agent(BACKGROUND_CONTEXT)
  const held = agent.model ? { providerID: "pi", modelID: `${agent.model.provider}/${agent.model.modelId}` } : undefined
  const selected = model ?? held ?? session.start.config.model ?? session.start.model
  return { models: await sessionModelCatalog(session.runtime), ...(selected ? { model: selected } : {}), effort: agent.thinkingLevel }
}

function draftConfigTarget(draft: DraftLaunch): Target {
  const model = draft.config.model ?? draft.model
  const credentials = new PiCredentials(draft.credentials, draft.providerDefinitions ?? [], async () => undefined)
  return { models: piCatalog(credentials), ...(model ? { model } : {}) }
}

function piConfigPreview(target: Target) {
  const models = target.models.map(({ id, name }) => ({ id, name, connected: true as const }))
  const model = target.models.find((row) => row.id === target.model?.modelID)
  const selected = model?.id
  return configOptionsPreview(modelAndEffortOptions({ models, ...(selected ? { selected } : {}),
    efforts: model?.efforts ?? [], ...(target.effort ? { currentEffort: target.effort } : {}) }))
}

export function createPiConfig(input: { session(session: HarnessSession): PiSession }): ConfigOperations {
  return {
    options: async (target) => piConfigPreview("session" in target ? await sessionConfigTarget(input.session(target.session), target.model) : draftConfigTarget(target.draft)),
    permissionModes: async (target) => permissionState("session" in target ? input.session(target.session).start.config : target.draft.config),
    setPermissionMode: async (session, modeId) => {
      if (!PI_PERMISSION_MODES.modes.some((mode) => mode.id === modeId)) throw piConfiguration(`Pi has no permission mode ${modeId}`)
      const entry = input.session(session)
      entry.start = { ...entry.start, config: { ...entry.start.config, permissionMode: modeId } }
      return permissionState(entry.start.config)
    },
    setModelSettings: (session, settings) => applyPiModelSettings(input.session(session), settings),
  }
}
