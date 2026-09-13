import type { HarnessEffortLevels } from "@claxedo/agent-runtime-contract"
import type { SdkModelEntry } from "./sdk-model-options"

/**
 * The effort catalog of a harness whose model rows carry their own levels
 * (Claude's `supportedEffortLevels`, Codex's `supportedReasoningEfforts`).
 *
 * An empty catalog is `unresolved`, not `unsupported`: `createLiveModelSource`
 * answers nothing until a probe has succeeded, and reporting that as "this
 * harness takes no effort" would refuse levels the harness accepts.
 */
export function harnessEffortLevels(models: readonly SdkModelEntry[]): HarnessEffortLevels {
  if (models.length === 0) return { status: "unresolved", models: [] }
  return {
    status: "resolved",
    models: models.flatMap((model) => {
      const levels = model.supportsEffort ? model.supportedEffortLevels ?? [] : []
      if (levels.length === 0) return []
      return [{
        modelID: model.id,
        levels: [...levels],
        ...(model.defaultEffort && levels.includes(model.defaultEffort) ? { default: model.defaultEffort } : {}),
      }]
    }),
  }
}
