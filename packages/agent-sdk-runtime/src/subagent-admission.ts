import { createHash, randomUUID } from "node:crypto"
import type {
  RuntimeDiagnostic,
  SubagentMode,
  SubagentStatus,
  SubagentToolCallRole,
  SubagentTranscript,
  SubagentUpdatedEvent,
  SubagentWake,
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
  attention?: number
  wake?: SubagentWake
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
    /**
     * Host-side child session allocation, invoked ONLY when the resolved
     * subagent has no child bound yet and the observation names none. Child
     * identity is owned HERE, by admission, so exactly one resolver decides
     * which row a child session belongs to. Splitting that ownership — a
     * caller picking/creating a childSessionId from its own state while
     * admission independently resolves the row — lets the same child id be
     * stamped toward a second row, which either trips the binding-compat
     * throw or crashes the turn on the durable store's unique child index
     * ("UNIQUE constraint failed: session_subagent.child_session_id").
     */
    allocateChildSessionId?: () => string
  }): AdmittedSubagentObservation
  markPublished(parentSessionId: string, observationId: string): void
}

export type SubagentAdmissionBoundary = {
  admit(
    parentSessionId: string,
    observation: SubagentObservation,
    options?: { allocateChildSessionId?: () => string },
  ): Promise<SubagentUpdatedEvent>
}

export function createSubagentAdmissionBoundary(input: {
  store: SubagentAdmissionStore
  publish: (parentSessionId: string, event: SubagentUpdatedEvent) => Promise<void> | void
  allocateKey?: () => string
}): SubagentAdmissionBoundary {
  return {
    async admit(parentSessionId, observation, options) {
      const admitted = input.store.admit({
        parentSessionId,
        observation,
        allocateKey: input.allocateKey ?? (() => `subagent_${randomUUID()}`),
        ...(options?.allocateChildSessionId ? { allocateChildSessionId: options.allocateChildSessionId } : {}),
      })
      if (admitted.published) return admitted.event
      await input.publish(parentSessionId, admitted.event)
      input.store.markPublished(parentSessionId, observation.observationId)
      return admitted.event
    },
  }
}

/**
 * A harness tool edge named a claxedo row this store holds no child for. The
 * host mints every claxedo row before `create_subagent` answers, so such an
 * edge can only have been read from text some tool printed; admitting it
 * would parent whichever session that text named. Thrown rather than
 * returned because every `admit` result is persisted by the durable stores.
 */
/**
 * Admits through the boundary, or publishes why a claxedo tool edge was set
 * aside. Tool output naming a child row the host never minted is not a fault
 * of the turn: the diagnostic takes the binding's place and the turn goes on.
 */
export async function admitSubagentObservation(
  boundary: SubagentAdmissionBoundary,
  publishDiagnostic: (event: { type: "diagnostic"; diagnostic: RuntimeDiagnostic }) => Promise<void> | void,
  ...args: Parameters<SubagentAdmissionBoundary["admit"]>
): Promise<SubagentUpdatedEvent | undefined> {
  try {
    return await boundary.admit(...args)
  } catch (error) {
    if (!(error instanceof UnknownHostSubagentKeyError)) throw error
    const observation = args[1]
    await publishDiagnostic({
      type: "diagnostic",
      diagnostic: {
        code: "subagent-binding-unknown",
        message: error.message,
        severity: "warn",
        source: "subagent-admission",
        details: {
          observationId: error.observationId,
          ...(error.subagentKey ? { subagentKey: error.subagentKey } : {}),
          ...(observation.toolCallId ? { toolCallId: observation.toolCallId } : {}),
        },
      },
    })
    return undefined
  }
}

export class UnknownHostSubagentKeyError extends Error {
  constructor(
    readonly parentSessionId: string,
    readonly observationId: string,
    readonly subagentKey: string | undefined,
  ) {
    super(`subagent observation ${observationId} names claxedo row ${subagentKey ?? "<none>"}, which ${parentSessionId} never created`)
    this.name = "UnknownHostSubagentKeyError"
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
  // Reverse index: which subagent key OWNS a child session. Child identity is
  // the strongest correlator (one child session belongs to exactly one
  // subagent — the durable store enforces it with a unique index), so an
  // observation naming an already-owned child must resolve to the owning row
  // no matter what its other keys say. The claude harness reports one Task
  // through two channels (a tool-call observation and a background-task
  // observation with disjoint keys); without this index the linking
  // observation resolved by its stable key to the SECOND row while carrying
  // the FIRST row's child — the durable write then died on the unique child
  // index and killed the whole turn.
  const childOwners = new Map<string, string>()

  return {
    admit(input) {
      const observationKey = scoped(input.parentSessionId, `observation:${input.observation.observationId}`)
      const existing = observations.get(observationKey)
      if (existing) {
        // childSessionId is excluded from the byte-equality check because
        // admission may have ALLOCATED it on first admit — a legitimate
        // duplicate delivery (another host instance, a replayed frame) lacks
        // it. A duplicate that names a DIFFERENT child is still a conflict.
        if (
          JSON.stringify(withoutChildSessionId(eventInput(existing.event))) !==
          JSON.stringify(withoutChildSessionId(observationEventInput(input.observation)))
        ) {
          throw new Error(`subagent observation ${input.observation.observationId} was reused with conflicting content`)
        }
        if (
          input.observation.childSessionId &&
          existing.event.childSessionId &&
          input.observation.childSessionId !== existing.event.childSessionId
        ) {
          throw new Error(`subagent observation ${input.observation.observationId} was reused with conflicting content`)
        }
        return existing
      }
      if (!!input.observation.toolCallId !== !!input.observation.toolCallRole) {
        throw new Error("subagent tool-call edges require both toolCallId and toolCallRole")
      }
      if (input.observation.providerKind === "claxedo" && input.observation.toolCallId) {
        const key = input.observation.subagentKey
        const bound = key ? bindings.get(scoped(input.parentSessionId, key)) : undefined
        if (!bound?.childSessionId) {
          throw new UnknownHostSubagentKeyError(input.parentSessionId, input.observation.observationId, key)
        }
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
      const childOwner = input.observation.childSessionId
        ? childOwners.get(scoped(input.parentSessionId, `child:${input.observation.childSessionId}`))
        : undefined
      // `correlationKeys` is ordered by strength — the id the provider itself
      // minted, then the harness's stable id, then the tool call — so an
      // observation whose keys name two different rows joins the row its
      // strongest key names rather than opening a third. A candidate whose
      // bound provider contradicts this observation is not one of its rows.
      const strongestMatch = () => {
        for (const key of associationKeys) {
          const match = sole([...(associations.get(scoped(input.parentSessionId, key)) ?? [])]
            .filter((candidate) => compatibleBinding(bindings.get(scoped(input.parentSessionId, candidate)), input.observation)))
          if (match) return match
        }
        return undefined
      }
      const resolved = input.observation.subagentKey
        ?? childOwner
        ?? (providerAssociation
          ? sole(associations.get(scoped(input.parentSessionId, providerAssociation))) ?? unboundMatch
          : undefined)
        ?? strongestMatch()
      const subagentKey = resolved ?? deterministicKey(input.parentSessionId, input.observation) ?? input.allocateKey()
      const bindingKey = scoped(input.parentSessionId, subagentKey)
      const binding = bindings.get(bindingKey) ?? {}
      requireCompatibleBinding("providerId", binding.providerId, input.observation.providerId)
      requireCompatibleBinding("providerKind", binding.providerKind, input.observation.providerKind)
      requireCompatibleBinding("childSessionId", binding.childSessionId, input.observation.childSessionId)
      // Admission owns child identity: reuse the row's bound child, else the
      // harness-named child, else allocate one (only when the caller says the
      // subagent's transcript is openable). This runs AFTER row resolution,
      // so the same child can never be handed to two rows.
      const childSessionId = binding.childSessionId
        ?? input.observation.childSessionId
        ?? input.allocateChildSessionId?.()
      if (childSessionId && !binding.childSessionId) {
        const childOwnerKey = scoped(input.parentSessionId, `child:${childSessionId}`)
        const owner = childOwners.get(childOwnerKey)
        // Reaching here with a foreign owner requires an explicit subagentKey
        // naming a different row than the child's owner — a protocol
        // violation. Refuse it with a legible error instead of letting the
        // durable layer crash on its unique child index.
        if (owner && owner !== subagentKey) {
          throw new Error(
            `subagent child session ${childSessionId} is already owned by ${owner}; observation ${input.observation.observationId} targets ${subagentKey}`,
          )
        }
        childOwners.set(childOwnerKey, subagentKey)
      }
      bindings.set(bindingKey, {
        providerId: binding.providerId ?? input.observation.providerId,
        providerKind: binding.providerKind ?? input.observation.providerKind,
        ...(childSessionId ? { childSessionId } : {}),
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
          ...observationEventInput({
            ...input.observation,
            ...(childSessionId ? { childSessionId } : {}),
          }),
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
