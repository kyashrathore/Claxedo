import type {
  ExecutionProfileDefaults,
  ExecutionProfileLevel,
  ResolvedExecutionProfile,
  ResolvedGenerationProfile,
} from "../contracts/execution"

const requiredFields = [
  "environment",
  "harness",
  "agent",
  "model",
  "effort",
  "tools",
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
      } | {
        readonly code: "unknown_agent_profile"
        readonly assignment: "planning" | "execution" | "review"
        readonly profileName: string
      }
    }

export function resolveExecutionProfile(
  hierarchy: ExecutionProfileHierarchy,
  assignment: "planning" | "execution" | "review" = "execution",
): ExecutionProfileResolution {
  const layers = [
    { level: "workgraph" as const, defaults: hierarchy.workgraph },
    ...(hierarchy.stream ? [{ level: "stream" as const, defaults: hierarchy.stream }] : []),
    ...(hierarchy.outcome ? [{ level: "outcome" as const, defaults: hierarchy.outcome }] : []),
    ...(hierarchy.workItem ? [{ level: "work_item" as const, defaults: hierarchy.workItem }] : []),
  ]
  const assignedName = [...layers].reverse().find((layer) => layer.defaults.assignments?.[assignment])?.defaults.assignments?.[assignment]
  const profiles = new Map(
    layers.flatMap((layer) => layer.defaults.agents ?? []).map((profile) => [profile.name, profile]),
  )
  const assigned = assignedName ? profiles.get(assignedName) : undefined
  if (assignedName && !assigned) {
    return { ok: false, error: { code: "unknown_agent_profile", assignment, profileName: assignedName } }
  }
  // New writes own the execution target on the Stream. The WorkGraph layer is
  // retained only as a read fallback for records created before that invariant;
  // public WorkGraph-default commands can no longer write these fields.
  const streamTarget = [
    { level: "workgraph" as const, defaults: hierarchy.workgraph },
    ...(hierarchy.stream ? [{ level: "stream" as const, defaults: hierarchy.stream }] : []),
  ]
  const resolved = {
    environment: resolveField(streamTarget, "environment"),
    repository: resolveField(streamTarget, "repository"),
    harness: resolveGenerationField(layers, assigned?.generation, "harness"),
    agent: resolveGenerationField(layers, assigned?.generation, "agent"),
    model: resolveGenerationField(layers, assigned?.generation, "model"),
    effort: resolveGenerationField(layers, assigned?.generation, "effort"),
    tools: resolveGenerationField(layers, assigned?.generation, "tools"),
    connectionIds: resolveGenerationField(layers, assigned?.generation, "connectionIds"),
  }
  const missingFields: (keyof ResolvedExecutionProfile)[] = requiredFields.filter((field) => resolved[field].value === undefined)
  if (!resolved.repository.value) missingFields.push("repository")
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
    connectionIds: [...(resolved.connectionIds.value ?? [])],
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

function resolveGenerationField<Field extends "harness" | "agent" | "model" | "effort" | "tools" | "connectionIds">(
  layers: readonly { readonly level: ExecutionProfileLevel; readonly defaults: ExecutionProfileDefaults }[],
  assigned: ResolvedGenerationProfile | undefined,
  field: Field,
) {
  const explicitWorkItem = layers.find((layer) => layer.level === "work_item" && layer.defaults[field] !== undefined)
  if (explicitWorkItem) {
    return {
      value: explicitWorkItem.defaults[field] as ResolvedExecutionProfile[Field],
      level: explicitWorkItem.level,
    }
  }
  if (assigned) return { value: assigned[field] as ResolvedExecutionProfile[Field], level: null }
  return resolveField(layers, field)
}

function deepFreeze<Value>(value: Value): Value {
  if (!value || typeof value !== "object") return value
  const record = value as Record<PropertyKey, unknown>
  Reflect.ownKeys(record).forEach((key) => deepFreeze(record[key]))
  return Object.freeze(value)
}
