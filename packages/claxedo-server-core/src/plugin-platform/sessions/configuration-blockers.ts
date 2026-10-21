import { cloudHarnessHost, harnessEffortRefusal, harnessProductLabel, parseHarnessEffortLevels, type SessionHarness } from "@claxedo/agent-runtime-contract"
import { asRecord, isRecord } from "@claxedo/helpers/guards"
import { sessionHarnessQuery } from "../../workspace/http/session-create-request"
import type { Workspace } from "../../workspace/store/index"
import type { SessionRuntimeTarget } from "./session-bridge-core"
import type { SessionModelConfiguration, SessionStartBlocker } from "./session-start"

export function workspaceNameOrDirectory(workspace: Workspace): string {
  return workspace.workspace_name || workspace.directory
}

/**
 * A harness whose cloud session runs in its own session host cannot start in
 * a cloud workspace's runtime, which is where every cloud-placement session is
 * created.
 */
export function cloudHarnessRefusal(harness: SessionHarness): string | undefined {
  if (harness.access !== "native" || cloudHarnessHost(harness.id) !== "session-host") return undefined
  const label = harnessProductLabel(harness.id) ?? harness.id
  return `${label} runs in its own session host on a cloud workspace, and a cloud session starts in the workspace's runtime. Choose another harness for a cloud session.`
}

/**
 * What the harness registered for this workspace says about the chosen model
 * and effort. A harness that selects its own model would run something other
 * than the one asked for, which is a refusal rather than a silent
 * substitution.
 */
export async function configurationBlockers(
  target: SessionRuntimeTarget,
  configuration: SessionModelConfiguration,
): Promise<SessionStartBlocker[]> {
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

function effortBlockers(value: unknown, configuration: SessionModelConfiguration): SessionStartBlocker[] {
  const detail = harnessEffortRefusal({
    harness: configuration.harness.id,
    catalog: parseHarnessEffortLevels(value),
    modelID: configuration.model.modelID,
    effort: configuration.effort ?? undefined,
  })
  return detail ? [{ code: "effort_unsupported", detail }] : []
}
