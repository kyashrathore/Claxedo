import type { RuntimeTokenUsage, RuntimeUsageObservation } from "./events"

/**
 * A turn's usage as independent streams: each scope's running usage, and the
 * last observation each scope applied, so a re-emitted one is not applied twice.
 * The turn's usage is the sum over every scope.
 */
export type UsageStreams = {
  streams: Map<string, RuntimeTokenUsage>
  lastObservationKeys: Map<string, string>
}

export function unknownTokenUsage(): RuntimeTokenUsage {
  return { input: null, output: null, reasoning: null, cache: { read: null, write: null } }
}

function add(previous: number | null, delta: number | null) {
  if (delta === null) return previous
  return (previous ?? 0) + delta
}

function applyObservation(previous: RuntimeTokenUsage, observation: Pick<RuntimeUsageObservation, "kind" | "tokens">): RuntimeTokenUsage {
  if (observation.kind === "cumulative") return observation.tokens
  const write1h = add(previous.cache.write1h ?? null, observation.tokens.cache.write1h ?? null)
  return {
    input: add(previous.input, observation.tokens.input),
    output: add(previous.output, observation.tokens.output),
    reasoning: add(previous.reasoning, observation.tokens.reasoning),
    cache: {
      read: add(previous.cache.read, observation.tokens.cache.read),
      write: add(previous.cache.write, observation.tokens.cache.write),
      ...(write1h === null ? {} : { write1h }),
    },
  }
}

/**
 * A scope's one-hour writes are a part of its cache writes. A share reported
 * above the total, or with no total at all, would make every revision of the
 * turn fail `assertTurnUsageRevision`.
 */
function oneHourWithinWrites(tokens: RuntimeTokenUsage): RuntimeTokenUsage {
  const { write1h, ...cache } = tokens.cache
  if (write1h === undefined || write1h === null) return tokens
  if (cache.write === null) return { ...tokens, cache }
  return write1h > cache.write ? { ...tokens, cache: { ...cache, write1h: cache.write } } : tokens
}

export function usageStreamsTotal(streams: ReadonlyMap<string, RuntimeTokenUsage>): RuntimeTokenUsage {
  let total = unknownTokenUsage()
  for (const tokens of streams.values()) total = applyObservation(total, { kind: "delta", tokens })
  return total
}

export function usageObservationKey(observation: RuntimeUsageObservation) {
  // Delta observation ids are event identities and remain replay keys. Codex
  // and Cursor cumulative ids identify the containing turn/run, so their
  // evolving token snapshots must include the counters in the signature.
  if (observation.kind === "delta" && observation.providerObservationId) {
    return observation.scope
      ? `provider:${observation.scope}:${observation.providerObservationId}`
      : `provider:${observation.providerObservationId}`
  }
  return JSON.stringify({
    kind: observation.kind,
    ...(observation.scope ? { scope: observation.scope } : {}),
    sequence: observation.sequence ?? null,
    providerObservationId: observation.providerObservationId ?? null,
    nativeSessionId: observation.nativeSessionId ?? null,
    observedAt: observation.observedAt ?? null,
    tokens: observation.tokens,
  })
}

export function isRepeatedUsageObservation(state: UsageStreams, observation: RuntimeUsageObservation) {
  return state.lastObservationKeys.get(observation.scope ?? "") === usageObservationKey(observation)
}

/** Applies one observation to its scope; a repeat of the scope's last observation changes nothing and returns false. */
export function recordUsageObservation(state: UsageStreams, observation: RuntimeUsageObservation): boolean {
  if (isRepeatedUsageObservation(state, observation)) return false
  const scope = observation.scope ?? ""
  state.streams.set(scope, oneHourWithinWrites(applyObservation(state.streams.get(scope) ?? unknownTokenUsage(), observation)))
  state.lastObservationKeys.set(scope, usageObservationKey(observation))
  return true
}

/** A turn's usage from its observations in the order they were reported. */
export function foldUsageObservations(observations: Iterable<RuntimeUsageObservation>): RuntimeTokenUsage {
  const state: UsageStreams = { streams: new Map(), lastObservationKeys: new Map() }
  for (const observation of observations) recordUsageObservation(state, observation)
  return usageStreamsTotal(state.streams)
}
