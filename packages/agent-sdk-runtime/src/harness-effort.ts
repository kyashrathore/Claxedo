import type { SdkModelEntry } from "./sdk-model-options"

/** One model's accepted effort levels, exactly as the harness reported them. */
export type HarnessModelEffort = {
  modelID: string
  levels: readonly string[]
  /** The level the harness runs when a turn names none. */
  default?: string
}

/**
 * `unsupported` — the harness has no effort control, so every level is refused.
 * `unresolved` — it has one, but no model catalog has answered yet, so neither
 * accepting nor refusing a level is grounded in what the harness said.
 * `resolved` — `models` is complete: a model absent from it takes no effort.
 */
export type HarnessEffortLevels = {
  status: "unsupported" | "unresolved" | "resolved"
  models: readonly HarnessModelEffort[]
}

export const NO_HARNESS_EFFORT: HarnessEffortLevels = { status: "unsupported", models: [] }

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

export type HarnessEffortVerdict = "accepted" | "refused" | "unknown"

/**
 * Whether a harness accepts an effort for a model, read off the same catalog
 * the capability response carries so no caller keeps a second list.
 *
 * `unknown` is distinct from `refused`: an unresolved catalog is an unanswered
 * question, and refusing a turn on it would ground the refusal in nothing.
 */
export function harnessEffortVerdict(
  catalog: HarnessEffortLevels | undefined,
  modelID: string | undefined,
  effort: string | undefined,
): HarnessEffortVerdict {
  if (!effort) return "accepted"
  if (!catalog) return "unknown"
  if (catalog.status === "unsupported") return "refused"
  if (catalog.status === "unresolved") return "unknown"
  const row = modelID ? catalog.models.find((model) => model.modelID === modelID) : undefined
  if (!row) return "refused"
  return row.levels.includes(effort) ? "accepted" : "refused"
}
