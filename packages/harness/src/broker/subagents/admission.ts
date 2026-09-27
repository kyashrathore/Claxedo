import { createHash } from "node:crypto"
import { UnknownHostSubagentKeyError, type SubagentObservation } from "@claxedo/agent-runtime-contract"
import type { SubagentUpdatedEvent } from "@claxedo/agent-runtime-contract"
import type { AdmittedSubagentObservation, SubagentAdmissionStore } from "../ports"

type AdmissionInput = Parameters<SubagentAdmissionStore["admit"]>[0]
type Binding = {
    providerId?: string
    providerKind?: string
    childSessionId?: string
}

class AdmissionMachine implements SubagentAdmissionStore {
  private observations = new Map<string, AdmittedSubagentObservation>()
  private associations = new Map<string, Set<string>>()
  private revisions = new Map<string, number>()
  private bindings = new Map<string, Binding>()
  private childOwners = new Map<string, string>()

  hasChild(parentSessionId: string, childSessionId: string): boolean {
    return this.childOwners.has(scoped(parentSessionId, `child:${childSessionId}`))
  }

  admit(input: AdmissionInput): AdmittedSubagentObservation {
    const observationKey = scoped(input.parentSessionId, `observation:${input.observation.observationId}`)
    const prior = this.observations.get(observationKey)
    if (prior) return this.replay(prior, input.observation)
    this.validate(input)
    const associationKeys = correlationKeys(input.observation)
    const subagentKey = this.resolve(input, associationKeys)
    const childSessionId = this.bind(input, subagentKey)
    const revisionKey = scoped(input.parentSessionId, `revision:${subagentKey}`)
    const revision = (this.revisions.get(revisionKey) ?? 0) + 1
    this.revisions.set(revisionKey, revision)
    this.associate(input.parentSessionId, associationKeys, subagentKey)
    const admitted: AdmittedSubagentObservation = {
      parentSessionId: input.parentSessionId,
      observationId: input.observation.observationId,
      event: { type: "subagent-updated", subagentKey, revision,
        ...observationEventInput({ ...input.observation, ...(childSessionId ? { childSessionId } : {}) }) },
      published: false,
    }
    this.observations.set(observationKey, admitted)
    return admitted
  }

  private replay(prior: AdmittedSubagentObservation, observation: SubagentObservation): AdmittedSubagentObservation {
    const same = JSON.stringify(withoutChildSessionId(eventInput(prior.event))) ===
      JSON.stringify(withoutChildSessionId(observationEventInput(observation)))
    const sameChild = !observation.childSessionId || !prior.event.childSessionId ||
      observation.childSessionId === prior.event.childSessionId
    if (!same || !sameChild) {
      throw new Error(`subagent observation ${observation.observationId} was reused with conflicting content`)
    }
    return prior
  }

  private validate(input: AdmissionInput): void {
    const observation = input.observation
    if (!!observation.toolCallId !== !!observation.toolCallRole) {
      throw new Error("subagent tool-call edges require both toolCallId and toolCallRole")
    }
    if (observation.providerKind !== "claxedo" || !observation.toolCallId) return
    const key = observation.subagentKey
    const bound = key ? this.bindings.get(scoped(input.parentSessionId, key)) : undefined
    if (!bound?.childSessionId) {
      throw new UnknownHostSubagentKeyError(input.parentSessionId, observation.observationId, key)
    }
  }

  private resolve(input: AdmissionInput, keys: string[]): string {
    const { parentSessionId, observation } = input
    const provider = providerKey(observation)
    const matches = keys.flatMap((key) => [...(this.associations.get(scoped(parentSessionId, key)) ?? [])])
    const unbound = sole(matches.filter((key) => {
      const binding = this.bindings.get(scoped(parentSessionId, key))
      return !binding?.providerId && (!observation.providerKind ||
        !binding?.providerKind || binding.providerKind === observation.providerKind)
    }))
    const childOwner = observation.childSessionId
      ? this.childOwners.get(scoped(parentSessionId, `child:${observation.childSessionId}`)) : undefined
    const resolved = observation.subagentKey ?? childOwner
      ?? (provider ? sole(this.associations.get(scoped(parentSessionId, provider))) ?? unbound : undefined)
      ?? this.strongest(parentSessionId, observation, keys)
    return resolved ?? deterministicKey(parentSessionId, observation) ?? input.allocateKey()
  }

  private strongest(parentSessionId: string, observation: SubagentObservation, keys: string[]): string | undefined {
    for (const key of keys) {
      const match = sole([...(this.associations.get(scoped(parentSessionId, key)) ?? [])]
        .filter((candidate) => compatibleBinding(this.bindings.get(scoped(parentSessionId, candidate)), observation)))
      if (match) return match
    }
    return undefined
  }

  private bind(input: AdmissionInput, key: string): string | undefined {
    const { parentSessionId, observation } = input
    const bindingKey = scoped(parentSessionId, key)
    const binding = this.bindings.get(bindingKey) ?? {}
    requireCompatibleBinding("providerId", binding.providerId, observation.providerId)
    requireCompatibleBinding("providerKind", binding.providerKind, observation.providerKind)
    requireCompatibleBinding("childSessionId", binding.childSessionId, observation.childSessionId)
    const child = binding.childSessionId ?? observation.childSessionId ?? input.allocateChildSessionId?.()
    if (child && !binding.childSessionId) {
      const ownerKey = scoped(parentSessionId, `child:${child}`)
      const owner = this.childOwners.get(ownerKey)
      if (owner && owner !== key) {
        throw new Error(`subagent child session ${child} is already owned by ${owner}; observation ${observation.observationId} targets ${key}`)
      }
      this.childOwners.set(ownerKey, key)
    }
    this.bindings.set(bindingKey, {
      providerId: binding.providerId ?? observation.providerId,
      providerKind: binding.providerKind ?? observation.providerKind,
      ...(child ? { childSessionId: child } : {}),
    })
    return child
  }

  private associate(parentSessionId: string, keys: string[], subagentKey: string): void {
    for (const key of keys) {
      const associationKey = scoped(parentSessionId, key)
      const values = this.associations.get(associationKey) ?? new Set<string>()
      values.add(subagentKey)
      this.associations.set(associationKey, values)
    }
  }

  markPublished(parentSessionId: string, observationId: string): void {
    const key = scoped(parentSessionId, `observation:${observationId}`)
    const admitted = this.observations.get(key)
    if (!admitted) throw new Error(`unknown subagent observation ${observationId}`)
    this.observations.set(key, { ...admitted, published: true })
  }

  records(): AdmittedSubagentObservation[] {
    return [...this.observations.values()]
  }
}

export function createMemorySubagentAdmissionStore(): SubagentAdmissionStore & {
  records(): AdmittedSubagentObservation[]
} {
  return new AdmissionMachine()
}

function eventInput(event: SubagentUpdatedEvent) {
  const { type: _type, subagentKey: _subagentKey, revision: _revision, ...input } = event
  return input
}

function withoutChildSessionId<T extends { childSessionId?: string }>(input: T) {
  const { childSessionId: _childSessionId, ...rest } = input
  return rest
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
    ...(observation.attention !== undefined ? { attention: observation.attention } : {}),
    ...(observation.wake ? { wake: observation.wake } : {}),
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
  if (!observation.providerId || !observation.providerKind) return undefined
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
  if (!seed) return undefined
  return `subagent_${createHash("sha256").update(`${parentSessionId}\0${seed}`).digest("hex").slice(0, 24)}`
}

function scoped(parentSessionId: string, key: string) {
  return `${parentSessionId}\0${key}`
}

function sole(values: Iterable<string> | undefined): string | undefined {
  if (!values) return undefined
  const unique = new Set(values)
  if (unique.size !== 1) return undefined
  return unique.values().next().value
}

function compatibleBinding(
  binding: { providerId?: string; providerKind?: string } | undefined,
  observation: SubagentObservation,
) {
  if (!binding) return true
  if (observation.providerId && binding.providerId && binding.providerId !== observation.providerId) return false
  if (observation.providerKind && binding.providerKind && binding.providerKind !== observation.providerKind) return false
  return true
}

function requireCompatibleBinding(field: string, current: string | undefined, next: string | undefined) {
  if (current === undefined || next === undefined || current === next) return
  throw new Error(`conflicting immutable subagent ${field} binding`)
}
