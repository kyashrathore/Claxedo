import type {
  ExecutionProfileDefaults,
  ExecutionProfileLevel,
  ResolvedExecutionProfile,
} from "../contracts/execution"

const requiredFields = [
  "environment",
  "harness",
  "agent",
  "model",
  "effort",
  "tools",
  "connectionIds",
  "isolation",
  "cleanup",
  "integration",
] as const satisfies readonly (keyof ResolvedExecutionProfile)[]

export interface ExecutionProfileHierarchy {
  readonly workgraph: ExecutionProfileDefaults
  readonly stream?: ExecutionProfileDefaults
  readonly outcome?: ExecutionProfileDefaults
  readonly workItem?: ExecutionProfileDefaults
}

export type ExecutionProfileProvenance = Readonly<{
  [Field in keyof ResolvedExecutionProfile]: ExecutionProfileLevel | null
}>

export type ExecutionProfileResolution =
  | {
      readonly ok: true
      readonly profile: ResolvedExecutionProfile
      readonly provenance: ExecutionProfileProvenance
    }
  | {
      readonly ok: false
      readonly error: {
        readonly code: "incomplete_execution_profile"
        readonly missingFields: readonly (keyof ResolvedExecutionProfile)[]
      }
    }

export function resolveExecutionProfile(hierarchy: ExecutionProfileHierarchy): ExecutionProfileResolution {
  const layers = [
    { level: "workgraph" as const, defaults: hierarchy.workgraph },
    ...(hierarchy.stream ? [{ level: "stream" as const, defaults: hierarchy.stream }] : []),
    ...(hierarchy.outcome ? [{ level: "outcome" as const, defaults: hierarchy.outcome }] : []),
    ...(hierarchy.workItem ? [{ level: "work_item" as const, defaults: hierarchy.workItem }] : []),
  ]
  const resolved = {
    environment: resolveField(layers, "environment"),
    repository: resolveField(layers, "repository"),
    harness: resolveField(layers, "harness"),
    agent: resolveField(layers, "agent"),
    model: resolveField(layers, "model"),
    effort: resolveField(layers, "effort"),
    tools: resolveField(layers, "tools"),
    connectionIds: resolveField(layers, "connectionIds"),
    isolation: resolveField(layers, "isolation"),
    cleanup: resolveField(layers, "cleanup"),
    integration: resolveField(layers, "integration"),
  }
  const missingFields: (keyof ResolvedExecutionProfile)[] = requiredFields.filter((field) => resolved[field].value === undefined)
  if (resolved.environment.value?.kind === "local_worktree" && !resolved.repository.value) missingFields.push("repository")
  if (missingFields.length > 0) {
    return { ok: false, error: { code: "incomplete_execution_profile", missingFields } }
  }

  const profile = deepFreeze({
    environment: { ...resolved.environment.value! },
    ...(resolved.repository.value ? { repository: { ...resolved.repository.value } } : {}),
    harness: resolved.harness.value!,
    agent: resolved.agent.value!,
    model: { ...resolved.model.value! },
    effort: resolved.effort.value!,
    tools: [...resolved.tools.value!],
    connectionIds: [...resolved.connectionIds.value!],
    isolation: resolved.isolation.value!,
    cleanup: resolved.cleanup.value!,
    integration: resolved.integration.value!,
  } satisfies ResolvedExecutionProfile)
  const provenance = Object.freeze({
    environment: resolved.environment.level,
    repository: resolved.repository.level,
    harness: resolved.harness.level,
    agent: resolved.agent.level,
    model: resolved.model.level,
    effort: resolved.effort.level,
    tools: resolved.tools.level,
    connectionIds: resolved.connectionIds.level,
    isolation: resolved.isolation.level,
    cleanup: resolved.cleanup.level,
    integration: resolved.integration.level,
  })
  return { ok: true, profile, provenance }
}

function resolveField<Field extends keyof ResolvedExecutionProfile>(
  layers: readonly { readonly level: ExecutionProfileLevel; readonly defaults: ExecutionProfileDefaults }[],
  field: Field,
): {
    readonly value: ResolvedExecutionProfile[Field] | undefined
    readonly level: ExecutionProfileLevel | null
  } {
  const winner = [...layers].reverse().find((layer) => layer.defaults[field] !== undefined)
  if (!winner) return { value: undefined, level: null }
  return { value: winner.defaults[field] as ResolvedExecutionProfile[Field], level: winner.level }
}

function deepFreeze<Value>(value: Value): Value {
  if (!value || typeof value !== "object") return value
  const record = value as Record<PropertyKey, unknown>
  Reflect.ownKeys(record).forEach((key) => deepFreeze(record[key]))
  return Object.freeze(value)
}
