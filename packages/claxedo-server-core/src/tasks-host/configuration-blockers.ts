import { harnessEffortRefusal, parseHarnessEffortLevels } from "@claxedo/agent-runtime-contract"
import { asRecord, isRecord } from "@claxedo/helpers/guards"
import { sessionHarnessQuery } from "@claxedo/server-core/workspace/http/session-create-request"
import type { ModelConfiguration, StartBlocker } from "@claxedo/tasks"
import type { Workspace } from "../workspace/store/index"
import type { TasksRuntimeTarget } from "./session-bridge-core"

export function workspaceNameOrDirectory(workspace: Workspace): string {
  return workspace.workspace_name || workspace.directory
}

/**
 * What the harness registered for this workspace says about the chosen model
 * and effort. A harness that selects its own model would run something other
 * than the preset's choice, which is a refusal rather than a silent
 * substitution.
 */
export async function configurationBlockers(
  target: TasksRuntimeTarget,
  configuration: ModelConfiguration,
): Promise<StartBlocker[]> {
  const response = await target
    .request(`/session/capabilities?${sessionHarnessQuery(configuration.harness)}`)
    .catch(() => undefined)
  if (!response?.ok) {
    return [{
      code: "harness_unavailable",
      detail: `The ${configuration.harness.id} harness is not available in ${workspaceNameOrDirectory(target.workspace)}`,
    }]
  }
  const body = asRecord(await response.json().catch(() => undefined))
  const effort = effortBlockers(body?.effortLevels, configuration)
  const selection = asRecord(body?.modelSelection)
  if (selection?.status === "unsupported") {
    return [{
      code: "model_unavailable",
      detail: `The ${configuration.harness.id} harness selects its own model and would ignore ${configuration.model.modelID}`,
    }, ...effort]
  }
  const models = Array.isArray(selection?.models) ? selection.models : []
  const offered = models.length === 0 || models.some((model) =>
    isRecord(model)
    && model.providerId === configuration.model.providerID
    && model.modelId === configuration.model.modelID)
  return [
    ...(offered ? [] : [{
      code: "model_unavailable" as const,
      detail: `${configuration.model.providerID}/${configuration.model.modelID} is not offered by the ${configuration.harness.id} harness here`,
    }]),
    ...effort,
  ]
}

function effortBlockers(value: unknown, configuration: ModelConfiguration): StartBlocker[] {
  const detail = harnessEffortRefusal({
    harness: configuration.harness.id,
    catalog: parseHarnessEffortLevels(value),
    modelID: configuration.model.modelID,
    effort: configuration.effort ?? undefined,
  })
  return detail ? [{ code: "effort_unsupported", detail }] : []
}
