import { PI_PERMISSION_MODES, type AgentPermissionModeState, type PromptModel, type SessionConfig } from "@claxedo/agent-runtime-contract"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai"
import type { ModelRef } from "@earendil-works/pi-durable"
import { configOptionsPreview, modelAndEffortOptions, type ConfigOperations, type DraftLaunch, type HarnessSession,
  type ModelSettings } from "../../contract"
import { piPermissionMode } from "./approvals"
import { PiCredentials } from "./credentials"
import { piConfiguration, piDirectCredentialRequired } from "./errors"
import type { PiSession } from "./session"

export function piModelRef(model: PromptModel | undefined): ModelRef {
  const slash = model?.modelID.indexOf("/") ?? -1
  if (!model || model.providerID !== "pi" || slash < 1 || slash === model.modelID.length - 1) throw piConfiguration("Pi requires a provider/model key")
  return { provider: model.modelID.slice(0, slash), modelId: model.modelID.slice(slash + 1) }
}

export function piCatalog(credentials: PiCredentials) {
  return credentials.catalogProviders().flatMap((provider) => credentials.models.getModels(provider)
    .map((model) => ({ id: `${provider}/${model.id}`, name: model.name || model.id, connected: true as const })))
}

export function piModel(credentials: PiCredentials, ref: ModelRef): Model<Api> {
  if (!credentials.direct(ref.provider)) throw piDirectCredentialRequired(ref.provider)
  const model = credentials.models.getModel(ref.provider, ref.modelId)
  if (!model) throw piConfiguration(`Pi does not offer model ${ref.provider}/${ref.modelId}`)
  return model
}

export function piThinkingLevel(model: Model<Api>, effort: string | null | undefined): ModelThinkingLevel | null | undefined {
  if (effort === null || effort === undefined) return effort
  const level = getSupportedThinkingLevels(model).find((candidate) => candidate === effort)
  if (!level) throw piConfiguration(`Pi does not run ${model.provider}/${model.id} at thinking level ${effort}`)
  return level
}

export async function applyPiModelSettings(session: PiSession, settings: ModelSettings): Promise<void> {
  const ref = piModelRef(settings.model)
  const model = piModel(session.credentials, ref)
  const thinkingLevel = piThinkingLevel(model, settings.effort)
  await session.runtime.conversation.configure({ model: ref, ...(thinkingLevel === undefined ? {} : { thinkingLevel }) }, BACKGROUND_CONTEXT)
}

function permissionState(config: Pick<SessionConfig, "permissionMode" | "permissionCeiling">): AgentPermissionModeState {
  return { modes: [...PI_PERMISSION_MODES.modes], currentModeId: piPermissionMode(config), appliesFrom: PI_PERMISSION_MODES.appliesFrom }
}

type Target = { credentials: PiCredentials; model?: PromptModel; effort?: string }

async function sessionConfigTarget(session: PiSession, model: PromptModel | undefined): Promise<Target> {
  const agent = await session.runtime.conversation.agent(BACKGROUND_CONTEXT)
  const held = agent.model ? { providerID: "pi", modelID: `${agent.model.provider}/${agent.model.modelId}` } : undefined
  const selected = model ?? held ?? session.start.config.model ?? session.start.model
  return { credentials: session.credentials, ...(selected ? { model: selected } : {}), effort: agent.thinkingLevel }
}

function draftConfigTarget(draft: DraftLaunch): Target {
  const model = draft.config.model ?? draft.model
  return { credentials: new PiCredentials(draft.credentials, draft.providerDefinitions ?? [], async () => undefined), ...(model ? { model } : {}) }
}

function piConfigPreview(target: Target) {
  const models = piCatalog(target.credentials)
  const selected = models.find((row) => row.id === target.model?.modelID)?.id
  const ref = selected ? piModelRef(target.model) : undefined
  const model = ref ? target.credentials.models.getModel(ref.provider, ref.modelId) : undefined
  return configOptionsPreview(modelAndEffortOptions({ models, ...(selected ? { selected } : {}),
    efforts: model ? getSupportedThinkingLevels(model) : [], ...(target.effort ? { currentEffort: target.effort } : {}) }))
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
