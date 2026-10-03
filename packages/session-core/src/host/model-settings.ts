import type { PromptModel, SessionConfig, SessionConfigUpdate } from "@claxedo/agent-runtime-contract"
import { applySessionConfigUpdate } from "@claxedo/harness/contract"
import { resolveSessionModel } from "../session/session-model"
import type { AttachedSession } from "./attachments"

function sameModel(left: PromptModel | undefined, right: PromptModel | undefined) {
  return left?.providerID === right?.providerID && left?.modelID === right?.modelID
}

/**
 * A model change that names no effort keeps the saved one only when the new
 * model offers it, and otherwise falls back to the harness default: the saved
 * effort was chosen for the old model, and forwarding it would refuse the change.
 */
async function withEffortForModel(attached: AttachedSession, current: SessionConfig, update: SessionConfigUpdate): Promise<SessionConfigUpdate> {
  if (update.model === undefined || update.variant !== undefined || !current.variant) return update
  const model = resolveSessionModel(applySessionConfigUpdate(current, { model: update.model }))
  if (sameModel(model, resolveSessionModel(current))) return update
  const config = attached.handle.transport.config
  const preview = model && config ? await config.options({ session: attached.session, model }, "probe") : undefined
  const efforts = preview?.options.find((option) => option.category === "thought_level")?.selectOptions ?? []
  return { ...update, variant: efforts.some((effort) => effort.id === current.variant) ? current.variant : null }
}

/**
 * Applies a model or effort change through the harness's live control and
 * returns the config to persist. The control receives the model the next turn
 * would run, so a reset reaches the harness as its resolved default.
 */
export async function applyModelSettings(attached: AttachedSession, current: SessionConfig, update: SessionConfigUpdate): Promise<SessionConfig> {
  const configured = applySessionConfigUpdate(current, await withEffortForModel(attached, current, update))
  if (!sameModel(configured.model, current.model) || (configured.variant ?? null) !== (current.variant ?? null)) {
    await attached.handle.transport.config?.setModelSettings?.(attached.session, {
      model: resolveSessionModel(configured), effort: configured.variant,
    })
  }
  return configured
}
