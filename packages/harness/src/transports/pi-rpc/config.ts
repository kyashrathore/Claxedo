import { piCredentialProviderIDs, type PromptModel, type TurnAccount } from "@claxedo/agent-runtime-contract"
import type { ConfigOperations, DraftLaunch, HarnessSession, StartInput } from "../../contract"
import { configOptionsPreview, modelAndEffortOptions, selectedTurnAccount } from "../../contract"
import { TransportError } from "../../contract/errors"
import type { PiRpc } from "./rpc"
import { asRecordOrEmpty, asString } from "@claxedo/helpers/guards"

export type PiCatalog = {
  models: { id: string; name: string; connected: true }[]
  efforts: string[]
  current?: { model?: string; effort?: string }
}

type ConfigEntry = { start: StartInput }

export function piModelSelection(model: PromptModel): { provider: string; modelId: string } {
  const slash = model.modelID.indexOf("/")
  if (model.providerID !== "pi" || slash < 1 || slash === model.modelID.length - 1) {
    throw new TransportError("pi", "configuration", "Pi requires a provider/model key")
  }
  return { provider: model.modelID.slice(0, slash), modelId: model.modelID.slice(slash + 1) }
}

export function piTurnAccount(start: StartInput, model: PromptModel | undefined): TurnAccount | undefined {
  return model ? selectedTurnAccount("pi", start.credentials, piCredentialProviderIDs(piModelSelection(model).provider)) : undefined
}

export async function piCatalog(rpc: PiRpc, model: PromptModel | undefined): Promise<PiCatalog> {
  const listed = asRecordOrEmpty(await rpc.request("get_available_models")).models
  if (!Array.isArray(listed)) throw new TransportError("pi", "protocol", "Pi returned an invalid model catalog")
  const models = listed.map((value: unknown) => {
    const row = asRecordOrEmpty(value)
    const provider = asString(row.provider)
    const id = asString(row.id)
    if (!provider || !id) throw new TransportError("pi", "protocol", "Pi model lacks provider/id")
    return { id: `${provider}/${id}`, name: asString(row.name) || id, connected: true as const }
  })
  if (model && models.some((item) => item.id === model.modelID)) await rpc.request("set_model", piModelSelection(model))
  const levels = asRecordOrEmpty(await rpc.request("get_available_thinking_levels")).levels
  const efforts = Array.isArray(levels) ? levels.filter((value): value is string => typeof value === "string") : []
  const state = asRecordOrEmpty(await rpc.request("get_state"))
  const selected = asRecordOrEmpty(state.model)
  const provider = asString(selected.provider)
  const id = asString(selected.id)
  return { models, efforts, current: { ...(provider && id ? { model: `${provider}/${id}` } : {}), ...(asString(state.thinkingLevel) ? { effort: asString(state.thinkingLevel) } : {}) } }
}

export function createPiConfig(input: {
  entry(session: HarnessSession): ConfigEntry
  catalog(draft: DraftLaunch, model: PromptModel | undefined, mode: "probe" | "peek"): Promise<PiCatalog>
}): ConfigOperations {
  return {
    options: async (target, mode) => {
      const draft = "session" in target ? input.entry(target.session).start : target.draft
      const model = ("session" in target ? target.model : undefined) ?? draft.config.model ?? draft.model
      const catalog = await input.catalog(draft, model, mode)
      const selected = model && catalog.models.some((item) => item.id === model.modelID) ? model.modelID : catalog.current?.model
      return configOptionsPreview(modelAndEffortOptions({ models: catalog.models, ...(selected ? { selected } : {}),
        efforts: catalog.efforts, ...(catalog.current?.effort ? { currentEffort: catalog.current.effort } : {}) }))
    },
    permissionModes: async () => ({ modes: [], unsupported: "Pi has no permission modes", appliesFrom: "next-turn" }),
    setPermissionMode: async () => { throw new TransportError("pi", "configuration", "Pi has no permission modes") },
  }
}
