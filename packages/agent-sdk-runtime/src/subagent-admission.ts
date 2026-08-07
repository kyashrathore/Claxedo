import { createHash, randomUUID } from "node:crypto"
import type {
  SubagentMode,
  SubagentStatus,
  SubagentToolCallRole,
  SubagentTranscript,
  SubagentUpdatedEvent,
} from "@claxedo/agent-event-runtime"

export type SubagentObservation = {
  observationId: string
  harnessExecutionId?: string
  subagentKey?: string
  stableCorrelationId?: string
  toolCallId?: string
  toolCallRole?: SubagentToolCallRole
  mode?: SubagentMode
  status?: SubagentStatus
  label?: string
  subagentType?: string
  description?: string
  providerId?: string
  providerKind?: string
  childSessionId?: string
  transcript?: SubagentTranscript
}

export type AdmittedSubagentObservation = {
  parentSessionId: string
  observationId: string
  event: SubagentUpdatedEvent
  published: boolean
}

export type SubagentAdmissionStore = {
  admit(input: {
    parentSessionId: string
    observation: SubagentObservation
    allocateKey: () => string
  }): AdmittedSubagentObservation
  markPublished(parentSessionId: string, observationId: string): void
}

export type SubagentAdmissionBoundary = {
  admit(parentSessionId: string, observation: SubagentObservation): Promise<SubagentUpdatedEvent>
}

export function createSubagentAdmissionBoundary(input: {
  store: SubagentAdmissionStore
  publish: (parentSessionId: string, event: SubagentUpdatedEvent) => Promise<void> | void
  allocateKey?: () => string
}): SubagentAdmissionBoundary {
  return {
    async admit(parentSessionId, observation) {
      const admitted = input.store.admit({
        parentSessionId,
        observation,
        allocateKey: input.allocateKey ?? (() => `subagent_${randomUUID()}`),
      })
      if (admitted.published) return admitted.event
      await input.publish(parentSessionId, admitted.event)
      input.store.markPublished(parentSessionId, observation.observationId)
      return admitted.event
    },
  }
}

export function createMemorySubagentAdmissionStore(): SubagentAdmissionStore & {
  records(): AdmittedSubagentObservation[]
} {
  const observations = new Map<string, AdmittedSubagentObservation>()
  const associations = new Map<string, Set<string>>()
  const revisions = new Map<string, number>()
  const bindings = new Map<string, {
    providerId?: string
    providerKind?: string
    childSessionId?: string
  }>()

  return {
    admit(input) {
      const observationKey = scoped(input.parentSessionId, `observation:${input.observation.observationId}`)
      const existing = observations.get(observationKey)
      if (existing) {
        if (JSON.stringify(eventInput(existing.event)) !== JSON.stringify(observationEventInput(input.observation))) {
          throw new Error(`subagent observation ${input.observation.observationId} was reused with conflicting content`)
        }
        return existing
      }
      if (!!input.observation.toolCallId !== !!input.observation.toolCallRole) {
        throw new Error("subagent tool-call edges require both toolCallId and toolCallRole")
      }

      const associationKeys = correlationKeys(input.observation)
      const providerAssociation = providerKey(input.observation)
      const associationMatches = associationKeys.flatMap((key) => [
        ...(associations.get(scoped(input.parentSessionId, key)) ?? []),
      ])
      const unboundMatch = sole(associationMatches.filter((key) => {
        const binding = bindings.get(scoped(input.parentSessionId, key))
        return !binding?.providerId && (
          !input.observation.providerKind ||
          !binding?.providerKind ||
          binding.providerKind === input.observation.providerKind
        )
      }))
      const resolved = input.observation.subagentKey
        ?? (providerAssociation
          ? sole(associations.get(scoped(input.parentSessionId, providerAssociation))) ?? unboundMatch
          : sole(associationMatches))
      const subagentKey = resolved ?? deterministicKey(input.parentSessionId, input.observation) ?? input.allocateKey()
      const bindingKey = scoped(input.parentSessionId, subagentKey)
      const binding = bindings.get(bindingKey) ?? {}
      requireCompatibleBinding("providerId", binding.providerId, input.observation.providerId)
      requireCompatibleBinding("providerKind", binding.providerKind, input.observation.providerKind)
      requireCompatibleBinding("childSessionId", binding.childSessionId, input.observation.childSessionId)
      bindings.set(bindingKey, {
        providerId: binding.providerId ?? input.observation.providerId,
        providerKind: binding.providerKind ?? input.observation.providerKind,
        childSessionId: binding.childSessionId ?? input.observation.childSessionId,
      })
      const revisionKey = scoped(input.parentSessionId, `revision:${subagentKey}`)
      const revision = (revisions.get(revisionKey) ?? 0) + 1
      revisions.set(revisionKey, revision)

      for (const key of associationKeys) {
        const associationKey = scoped(input.parentSessionId, key)
        const values = associations.get(associationKey) ?? new Set<string>()
        values.add(subagentKey)
        associations.set(associationKey, values)
      }

      const admitted = {
        parentSessionId: input.parentSessionId,
        observationId: input.observation.observationId,
        event: {
          type: "subagent-updated",
          subagentKey,
          revision,
          ...observationEventInput(input.observation),
        },
        published: false,
      } satisfies AdmittedSubagentObservation
      observations.set(observationKey, admitted)
      return admitted
    },
    markPublished(parentSessionId, observationId) {
      const key = scoped(parentSessionId, `observation:${observationId}`)
      const admitted = observations.get(key)
      if (!admitted) throw new Error(`unknown subagent observation ${observationId}`)
      observations.set(key, { ...admitted, published: true })
    },
    records() {
      return [...observations.values()]
    },
  }
}

function eventInput(event: SubagentUpdatedEvent) {
  const { type: _type, subagentKey: _subagentKey, revision: _revision, ...input } = event
  return input
}

function observationEventInput(observation: SubagentObservation) {
  return {
    ...(observation.toolCallId ? { toolCallId: observation.toolCallId } : {}),
    ...(observation.toolCallRole ? { toolCallRole: observation.toolCallRole } : {}),
    ...(observation.mode ? { mode: observation.mode } : {}),
    ...(observation.status ? { status: observation.status } : {}),
    ...(observation.label ? { label: observation.label } : {}),
    ...(observation.subagentType ? { subagentType: observation.subagentType } : {}),
    ...(observation.description ? { description: observation.description } : {}),
    ...(observation.providerId ? { providerId: observation.providerId } : {}),
    ...(observation.providerKind ? { providerKind: observation.providerKind } : {}),
    ...(observation.childSessionId ? { childSessionId: observation.childSessionId } : {}),
    ...(observation.transcript ? { transcript: observation.transcript } : {}),
  }
}

function correlationKeys(observation: SubagentObservation) {
  return [
    providerKey(observation),
    observation.stableCorrelationId ? `stable:${observation.harnessExecutionId ?? ""}:${observation.stableCorrelationId}` : undefined,
    observation.toolCallId ? `tool:${observation.harnessExecutionId ?? ""}:${observation.toolCallId}` : undefined,
  ].filter((key): key is string => !!key)
}

function providerKey(observation: SubagentObservation) {
  if (!observation.providerId || !observation.providerKind) return
  return `provider:${observation.providerKind}:${observation.providerId}`
}

function deterministicKey(parentSessionId: string, observation: SubagentObservation) {
  const provider = providerKey(observation)
  const seed = provider
    ?? (observation.stableCorrelationId
      ? `stable:${observation.harnessExecutionId ?? ""}:${observation.stableCorrelationId}`
      : observation.toolCallId
        ? `tool:${observation.harnessExecutionId ?? ""}:${observation.toolCallId}`
        : undefined)
  if (!seed) return
  return `subagent_${createHash("sha256").update(`${parentSessionId}\0${seed}`).digest("hex").slice(0, 24)}`
}

function scoped(parentSessionId: string, key: string) {
  return `${parentSessionId}\0${key}`
}

function sole(values: Iterable<string> | undefined) {
  if (!values) return
  const unique = new Set(values)
  if (unique.size !== 1) return
  return unique.values().next().value
}

function requireCompatibleBinding(field: string, current: string | undefined, next: string | undefined) {
  if (current === undefined || next === undefined || current === next) return
  throw new Error(`conflicting immutable subagent ${field} binding`)
}
