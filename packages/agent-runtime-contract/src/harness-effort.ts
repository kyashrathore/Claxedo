import { isRecord } from "./values"

/**
 * The closed set of effort words a harness may be asked for, mirroring the
 * Claude Agent SDK's `EffortLevel` union. This is the VOCABULARY; which of
 * these words a given model accepts is `HarnessEffortLevels` below.
 */
export const HARNESS_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const
export type HarnessEffortLevel = (typeof HARNESS_EFFORT_LEVELS)[number]

/** Sound because `HARNESS_EFFORT_LEVELS` is the tuple `HarnessEffortLevel` is derived from. */
export function isHarnessEffortLevel(value: string): value is HarnessEffortLevel {
  return (HARNESS_EFFORT_LEVELS as readonly string[]).includes(value)
}

/** One model's accepted effort levels, exactly as the harness reported them. */
export type HarnessModelEffort = {
  modelID: string
  levels: readonly string[]
  /** The level the harness runs when a turn names none. */
  default?: string
}

/**
 * Which effort words a harness accepts, per model, and how sure it is.
 *
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

/** The catalog a capability response carries, or `undefined` when it carries none. */
export function parseHarnessEffortLevels(value: unknown): HarnessEffortLevels | undefined {
  if (!isRecord(value)) return undefined
  const status = value.status
  if (status !== "resolved" && status !== "unresolved" && status !== "unsupported") return undefined
  const models = Array.isArray(value.models) ? value.models : []
  return {
    status,
    models: models.flatMap((entry: unknown) => {
      if (!isRecord(entry)) return []
      const modelID = entry.modelID
      if (typeof modelID !== "string" || !modelID) return []
      const levels = Array.isArray(entry.levels)
        ? entry.levels.filter((level: unknown): level is string => typeof level === "string" && !!level)
        : []
      return [{
        modelID,
        levels,
        ...(typeof entry.default === "string" && entry.default ? { default: entry.default } : {}),
      }]
    }),
  }
}

/**
 * The sentence a caller refuses a configuration's effort with, or `undefined`
 * when the effort must be admitted.
 *
 * Only a `resolved` catalog refuses. `unresolved` has not answered yet, and
 * `unsupported` is what every harness whose model rows carry no per-model
 * levels reports even when it honours a level anyway — Pi runs the
 * `set_thinking_level` it never publishes a catalog for — so refusing on
 * either would refuse on silence rather than on what the harness said.
 */
export function harnessEffortRefusal(input: {
  harness: string
  catalog: HarnessEffortLevels | undefined
  modelID: string | undefined
  effort: string | undefined
}): string | undefined {
  if (input.catalog?.status !== "resolved") return undefined
  if (!input.effort) return undefined
  if (harnessEffortVerdict(input.catalog, input.modelID, input.effort) !== "refused") return undefined
  const levels = input.catalog.models.find((model) => model.modelID === input.modelID)?.levels ?? []
  return `The ${input.harness} harness does not run ${input.modelID ?? "its default model"} at effort ${input.effort}; ${
    levels.length > 0 ? `it accepts ${levels.join(", ")}` : "it accepts no effort for that model"
  }`
}
