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
 * The fields a config write moved, as the config it produced holds them. A
 * write persists only these: the harness can take long enough to apply it for
 * a permission mode or a handoff to be stored meanwhile, and persisting the
 * whole config read before it would put those back.
 */
export function writtenConfig(configured: SessionConfig, update: SessionConfigUpdate): SessionConfigUpdate {
  const moved = (key: keyof SessionConfigUpdate) => update[key] !== undefined
  return {
    ...(moved("harness") ? { harness: configured.harness } : {}),
    ...(moved("permissionCeiling") ? { permissionCeiling: configured.permissionCeiling } : {}),
    ...(moved("permissionMode") ? { permissionMode: configured.permissionMode ?? null } : {}),
    ...(moved("permissionModeLabel") ? { permissionModeLabel: configured.permissionModeLabel ?? null } : {}),
    ...(moved("permissionState") ? { permissionState: configured.permissionState ?? null } : {}),
    ...(moved("model") ? { model: configured.model ?? null } : {}),
    ...(moved("variant") ? { variant: configured.variant ?? null } : {}),
    ...(moved("agent") ? { agent: configured.agent ?? null } : {}),
    ...(moved("instructions") ? { instructions: configured.instructions ?? null } : {}),
    ...(moved("group") ? { group: configured.group ?? null } : {}),
    ...(moved("handoff") ? { handoff: configured.handoff ?? null } : {}),
  }
}

/**
 * Applies a model or effort change through the harness's live control and
 * returns the fields to persist. The control receives the model the next turn
 * would run, so a reset reaches the harness as its resolved default.
 */
export async function applyModelSettings(attached: AttachedSession, current: SessionConfig, update: SessionConfigUpdate): Promise<SessionConfigUpdate> {
  const applied = await withEffortForModel(attached, current, update)
  const configured = applySessionConfigUpdate(current, applied)
  if (!sameModel(configured.model, current.model) || (configured.variant ?? null) !== (current.variant ?? null)) {
    await attached.handle.transport.config?.setModelSettings?.(attached.session, {
      model: resolveSessionModel(configured), effort: configured.variant,
    })
  }
  return writtenConfig(configured, applied)
}
