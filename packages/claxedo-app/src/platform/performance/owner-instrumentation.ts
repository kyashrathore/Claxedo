import { SUBTRACTION_OWNERS, type SubtractionOwner } from "./subtraction"

export type OwnerInstrumentationKind = "mount" | "dispose" | "execution" | "resource-acquire" | "resource-release"

export type OwnerInstrumentationEvent = Readonly<{
  schema: 1
  sequence: number
  owner: SubtractionOwner
  label: string
  kind: OwnerInstrumentationKind
  activeInstances: number
  activeResources: number
  executionCount: number
  atMs: number
}>

export type OwnerInstrumentationSink = {
  record(event: OwnerInstrumentationEvent): void
}

export type OwnerInstrumentationTarget = {
  /** Existing opt-in renderer trace switch. */
  __claxedoPerfTrace?: boolean
  /** Owner events captured by the existing trace surface. */
  __claxedoPerfOwnerEvents?: OwnerInstrumentationEvent[]
  /** Optional streaming collector installed by a benchmark observer. */
  __CLAXEDO_OWNER_INSTRUMENTATION__?: OwnerInstrumentationSink
}

type OwnerCounts = {
  instances: number
  resources: number
  executions: number
}

type InstrumentationState = {
  sequence: number
  counts: Map<SubtractionOwner, OwnerCounts>
}

const stateKey = Symbol("claxedo-owner-instrumentation-state")
const noDispose = () => {}

type StatefulSink = OwnerInstrumentationSink & {
  [stateKey]?: InstrumentationState
}

function stateFor(sink: OwnerInstrumentationSink) {
  const stateful = sink as StatefulSink
  if (stateful[stateKey]) return stateful[stateKey]
  return (stateful[stateKey] = { sequence: 0, counts: new Map() })
}

function sinkFor(target: OwnerInstrumentationTarget) {
  if (target.__CLAXEDO_OWNER_INSTRUMENTATION__) return target.__CLAXEDO_OWNER_INSTRUMENTATION__
  if (target.__claxedoPerfTrace !== true) return
  const events = target.__claxedoPerfOwnerEvents ??= []
  const sink: OwnerInstrumentationSink = { record: (event) => events.push(event) }
  target.__CLAXEDO_OWNER_INSTRUMENTATION__ = sink
  return sink
}

function record(
  target: OwnerInstrumentationTarget,
  owner: SubtractionOwner,
  label: string,
  kind: OwnerInstrumentationKind,
  now: () => number,
) {
  const sink = sinkFor(target)
  if (!sink) return
  // Runtime sinks are extension points; refuse an invalid owner before it can
  // contaminate the one-owner subtraction ledger. This check remains behind
  // the opt-in sink, so normal product paths stay allocation- and clock-free.
  if (!(SUBTRACTION_OWNERS as readonly string[]).includes(owner)) return
  const state = stateFor(sink)
  const counts = state.counts.get(owner) ?? { instances: 0, resources: 0, executions: 0 }
  if (kind === "mount") counts.instances += 1
  if (kind === "dispose") counts.instances = Math.max(0, counts.instances - 1)
  if (kind === "resource-acquire") counts.resources += 1
  if (kind === "resource-release") counts.resources = Math.max(0, counts.resources - 1)
  if (kind === "execution") counts.executions += 1
  state.counts.set(owner, counts)
  const event: OwnerInstrumentationEvent = Object.freeze({
    schema: 1,
    sequence: ++state.sequence,
    owner,
    label,
    kind,
    activeInstances: counts.instances,
    activeResources: counts.resources,
    executionCount: counts.executions,
    atMs: now(),
  })
  try {
    sink.record(event)
  } catch {
    // Diagnostic collection must never become a product failure boundary.
  }
}

export function instrumentOwnerMount(
  owner: SubtractionOwner,
  label: string,
  options: {
    target?: OwnerInstrumentationTarget
    now?: () => number
  } = {},
): VoidFunction {
  const target = options.target ?? globalThis as OwnerInstrumentationTarget
  // Avoid a clock read, map allocation, and closure in normal product use.
  if (!sinkFor(target)) return noDispose
  const now = options.now ?? (() => performance.now())
  record(target, owner, label, "mount", now)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    record(target, owner, label, "dispose", now)
  }
}

export function instrumentOwnerExecution(
  owner: SubtractionOwner,
  label: string,
  options: {
    target?: OwnerInstrumentationTarget
    now?: () => number
  } = {},
) {
  const target = options.target ?? globalThis as OwnerInstrumentationTarget
  if (!sinkFor(target)) return
  record(target, owner, label, "execution", options.now ?? (() => performance.now()))
}

export function instrumentOwnerResource(
  owner: SubtractionOwner,
  label: string,
  options: {
    target?: OwnerInstrumentationTarget
    now?: () => number
  } = {},
): VoidFunction {
  const target = options.target ?? globalThis as OwnerInstrumentationTarget
  if (!sinkFor(target)) return noDispose
  const now = options.now ?? (() => performance.now())
  record(target, owner, label, "resource-acquire", now)
  let released = false
  return () => {
    if (released) return
    released = true
    record(target, owner, label, "resource-release", now)
  }
}
