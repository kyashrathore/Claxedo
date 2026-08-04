import type { LocalDiagnostics } from "@claxedo/app/process-diagnostics-contract"

import type { ElectronDiagnosticsSource, ElectronRoot } from "./electron-source"
import type { DiagnosticsOwnerEvent } from "../../shared/diagnostics-transport"
import {
  createDiagnosticsActions,
  type ActionClaim,
  type OwnerOperation,
} from "./actions"

export const DIAGNOSTICS_TARGET_WINDOW_MS = 15 * 60 * 1_000
export const DIAGNOSTICS_MAX_BYTES = 20 * 1024 * 1024
export const DIAGNOSTICS_STARTUP_INTERVAL_MS = 500
export const DIAGNOSTICS_STARTUP_DURATION_MS = 120_000
export const DIAGNOSTICS_STEADY_INTERVAL_MS = 2_000

export type DiagnosticsObservation = {
  owner: LocalDiagnostics.OwnerIdentity
  process: LocalDiagnostics.ProcessRecord
  point: LocalDiagnostics.MetricPoint
}

export type DiagnosticsSource = {
  id: LocalDiagnostics.SourceId
  domain: LocalDiagnostics.Domain
  accuracy: LocalDiagnostics.SourceStatus["accuracy"]
  capabilities: LocalDiagnostics.SourceCapabilities
  collect(at: number): DiagnosticsObservation[] | Promise<DiagnosticsObservation[]>
  statuses?(): LocalDiagnostics.SourceStatus[]
  getStats?(): Record<string, number>
  registerRoot?(root: ElectronRoot): () => void
  revalidateIdentity?(identity: LocalDiagnostics.ProcessIdentity): Promise<boolean>
  dispose?(): void
}

export type DiagnosticsClock = {
  now(): number
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(id: unknown): void
}

type UtilityProcessLike = {
  pid?: number
  on(event: "spawn", listener: () => void): unknown
  once(event: "exit", listener: (code: number | null) => void): unknown
  off?(event: "spawn", listener: () => void): unknown
}

type SampleReason = "periodic" | "manual" | "lifecycle"

export type Profiler = ReturnType<typeof createProfiler>

export function createProfiler(options: {
  source: DiagnosticsSource
  clock?: DiagnosticsClock
  targetWindowMs?: number
  maxBytes?: number
  startupIntervalMs?: number
  startupDurationMs?: number
  steadyIntervalMs?: number
  actionToken?: () => string
  actionTtlMs?: number
}) {
  const clock = options.clock ?? realClock
  const targetWindowMs = options.targetWindowMs ?? DIAGNOSTICS_TARGET_WINDOW_MS
  const maxBytes = options.maxBytes ?? DIAGNOSTICS_MAX_BYTES
  const startupIntervalMs = options.startupIntervalMs ?? DIAGNOSTICS_STARTUP_INTERVAL_MS
  const startupDurationMs = options.startupDurationMs ?? DIAGNOSTICS_STARTUP_DURATION_MS
  const steadyIntervalMs = options.steadyIntervalMs ?? DIAGNOSTICS_STEADY_INTERVAL_MS
  const startedAt = clock.now()
  const generation = `diagnostics-${String(startedAt)}-${String(process.pid)}`
  const samples: LocalDiagnostics.MetricPoint[] = []
  const markers: LocalDiagnostics.Marker[] = []
  const owners = new Map<string, LocalDiagnostics.OwnerIdentity>()
  const processes = new Map<string, LocalDiagnostics.ProcessRecord>()
  const activeByPid = new Map<number, string>()
  const listeners = new Set<(snapshot: LocalDiagnostics.RetainedSnapshot) => void>()
  const stats = {
    sourceAttempts: 0,
    collections: 0,
    droppedTicks: 0,
    lateTicks: 0,
    retainedBytes: 0,
    retainedProcesses: 0,
    retainedSamples: 0,
    retainedMarkers: 0,
    lastSourceDurationMs: 0,
    maxSourceDurationMs: 0,
    totalSourceDurationMs: 0,
  }
  const sourceBase = {
    source: options.source.id,
    domain: options.source.domain,
    accuracy: options.source.accuracy,
    capabilities: options.source.capabilities,
  }
  let sourceStatus: LocalDiagnostics.SourceStatus = {
    ...sourceBase,
    state: "warming-up",
  }
  let timer: unknown
  let burstTimer: unknown
  let inFlight = false
  let burstPending = false
  let disposed = false
  let interactive = false
  let pressureTruncated = false
  let markerSequence = 0
  const additionalSourceStates = new Map<LocalDiagnostics.SourceId, LocalDiagnostics.SourceStatus["state"]>()
  const observedOwnerRoots = new Map<
    string,
    {
      descriptor: Extract<DiagnosticsOwnerEvent, { type: "owner-registered" }>["descriptor"]
      unregister: () => void
    }
  >()
  const actions = createDiagnosticsActions({
    generation,
    now: clock.now,
    ...(options.actionToken ? { token: options.actionToken } : {}),
    ...(options.actionTtlMs ? { ttlMs: options.actionTtlMs } : {}),
  })

  appendMarker({
    type: "lifecycle",
    id: nextMarkerId(),
    at: startedAt,
    event: "profiler-started",
    source: options.source.id,
  })
  runCollection("manual")

  function runCollection(reason: SampleReason) {
    if (disposed) return
    if (inFlight) {
      if (reason === "lifecycle") {
        burstPending = true
        return
      }
      stats.droppedTicks++
      return
    }
    if (timer !== undefined) {
      clock.clearTimeout(timer)
      timer = undefined
    }
    inFlight = true
    const collectedAt = clock.now()
    const expectedInterval = currentInterval(collectedAt)
    let output: DiagnosticsObservation[] | Promise<DiagnosticsObservation[]>
    try {
      output = options.source.collect(collectedAt)
    } catch {
      finishFailure("source-failed")
      return
    }
    if (output instanceof Promise) {
      void output.then(finishSuccess, () => finishFailure("source-failed"))
      return
    }
    finishSuccess(output)

    function finishSuccess(observations: DiagnosticsObservation[]) {
      if (disposed) return
      const finishedAt = clock.now()
      recordSourceDuration(finishedAt - collectedAt)
      const late = finishedAt - collectedAt > expectedInterval
      observations.forEach(appendObservation)
      markMissingProcessesExited(
        new Set(observations.map((observation) => observation.process.identity.id)),
        finishedAt,
      )
      stats.collections++
      syncAdditionalSourceStatuses(finishedAt)
      if (!late) setSourceHealthy(finishedAt)
      if (late) stats.lateTicks++
      if (late) setSourceDegraded("source-timeout", finishedAt)
      finishCollection()
    }

    function finishFailure(reason: LocalDiagnostics.UnavailableReason) {
      if (disposed) return
      const finishedAt = clock.now()
      recordSourceDuration(finishedAt - collectedAt)
      setSourceDegraded(reason, finishedAt)
      finishCollection()
    }

    function finishCollection() {
      inFlight = false
      notify(trim(clock.now()))
      if (burstPending) {
        burstPending = false
        scheduleBurst()
        return
      }
      schedulePeriodic()
    }

    function recordSourceDuration(value: number) {
      const duration = Math.max(0, value)
      stats.sourceAttempts++
      stats.lastSourceDurationMs = duration
      stats.maxSourceDurationMs = Math.max(stats.maxSourceDurationMs, duration)
      stats.totalSourceDurationMs += duration
    }
  }

  function schedulePeriodic() {
    if (disposed) return
    const delay = currentInterval(clock.now())
    timer = clock.setTimeout(() => {
      timer = undefined
      runCollection("periodic")
    }, delay)
  }

  function currentInterval(at: number) {
    return !interactive && at - startedAt < startupDurationMs ? startupIntervalMs : steadyIntervalMs
  }

  function scheduleBurst() {
    if (disposed || burstTimer !== undefined) return
    if (timer !== undefined) {
      clock.clearTimeout(timer)
      timer = undefined
    }
    burstTimer = clock.setTimeout(() => {
      burstTimer = undefined
      runCollection("lifecycle")
    }, 0)
  }

  function appendObservation(observation: DiagnosticsObservation) {
    owners.set(observation.owner.id, observation.owner)
    const previousId = activeByPid.get(observation.process.identity.pid)
    if (previousId && previousId !== observation.process.identity.id) {
      markProcessExited(previousId, observation.point.at)
    }
    if (!processes.has(observation.process.identity.id)) {
      appendMarker({
        type: "lifecycle",
        id: nextMarkerId(),
        at: observation.point.at,
        event: "process-appeared",
        ownerId: observation.process.ownerId,
        processId: observation.process.identity.id,
        source: options.source.id,
      })
    }
    processes.set(observation.process.identity.id, observation.process)
    activeByPid.set(observation.process.identity.pid, observation.process.identity.id)
    const existing = findCurrentSample(observation.point)
    if (existing >= 0) {
      samples[existing] = mergeMetricPoints(samples[existing]!, observation.point)
      return
    }
    samples.push(observation.point)
  }

  function findCurrentSample(point: LocalDiagnostics.MetricPoint) {
    for (let index = samples.length - 1; index >= 0; index--) {
      const sample = samples[index]!
      if (sample.at < point.at) return -1
      if (sample.at === point.at && sample.processId === point.processId) return index
    }
    return -1
  }

  function setSourceHealthy(at: number) {
    const recovered = sourceStatus.state === "degraded" || sourceStatus.state === "failed"
    sourceStatus = {
      ...sourceBase,
      state: "healthy",
      lastSuccessAt: at,
    }
    if (!recovered) return
    appendMarker({
      type: "lifecycle",
      id: nextMarkerId(),
      at,
      event: "source-recovered",
      source: options.source.id,
    })
  }

  function setSourceDegraded(reason: LocalDiagnostics.UnavailableReason, at: number) {
    if (sourceStatus.state === "degraded" && sourceStatus.reason === reason) return
    const lastSuccessAt =
      sourceStatus.state !== "unsupported" && "lastSuccessAt" in sourceStatus ? sourceStatus.lastSuccessAt : undefined
    sourceStatus = {
      ...sourceBase,
      state: "degraded",
      reason,
      ...(lastSuccessAt === undefined ? {} : { lastSuccessAt }),
    }
    appendMarker({
      type: "lifecycle",
      id: nextMarkerId(),
      at,
      event: "source-degraded",
      source: options.source.id,
    })
  }

  function syncAdditionalSourceStatuses(at: number) {
    options.source.statuses?.().forEach((status) => {
      const previous = additionalSourceStates.get(status.source)
      additionalSourceStates.set(status.source, status.state)
      if (!previous || previous === status.state) return
      const degraded = status.state === "degraded" || status.state === "failed"
      const recovered = status.state === "healthy" && (previous === "degraded" || previous === "failed")
      if (!degraded && !recovered) return
      appendMarker({
        type: "lifecycle",
        id: nextMarkerId(),
        at,
        event: degraded ? "source-degraded" : "source-recovered",
        source: status.source,
      })
    })
  }

  function appendMarker(marker: LocalDiagnostics.Marker) {
    markers.push(marker)
  }

  function recordLifecycle(marker: Omit<LocalDiagnostics.LifecycleMarker, "type" | "id" | "at"> & { at?: number }) {
    if (disposed) return
    const id = nextMarkerId()
    appendMarker({
      type: "lifecycle",
      id,
      at: marker.at ?? clock.now(),
      event: marker.event,
      ...(marker.ownerId ? { ownerId: marker.ownerId } : {}),
      ...(marker.processId ? { processId: marker.processId } : {}),
      ...(marker.source ? { source: marker.source } : {}),
      ...(marker.action ? { action: marker.action } : {}),
      ...(marker.outcome ? { outcome: marker.outcome } : {}),
    })
    notify(trim(clock.now()))
    scheduleBurst()
    return id
  }

  function nextMarkerId() {
    markerSequence++
    return `${generation}-marker-${String(markerSequence)}`
  }

  function markMissingProcessesExited(observed: Set<string>, at: number) {
    Array.from(activeByPid.values()).forEach((processId) => {
      if (observed.has(processId)) return
      markProcessExited(processId, at)
    })
  }

  function markProcessExited(processId: string, at: number) {
    const running = processes.get(processId)
    if (!running || running.lifecycle === "exited") return
    processes.set(processId, { ...running, lifecycle: "exited" })
    if (activeByPid.get(running.identity.pid) === processId) activeByPid.delete(running.identity.pid)
    appendMarker({
      type: "lifecycle",
      id: nextMarkerId(),
      at,
      event: "process-exited",
      ownerId: running.ownerId,
      processId,
      source: options.source.id,
    })
    if (!running.ownerId) return
    const owner = owners.get(running.ownerId)
    const ownerStillActive = [...processes.values()].some(
      (process) =>
        process.identity.id !== processId && process.ownerId === running.ownerId && process.lifecycle !== "exited",
    )
    if (!owner || ownerStillActive) return
    owners.set(owner.id, { ...owner, lifecycle: "historical" })
  }

  function trim(at: number) {
    const cutoff = Math.max(startedAt, at - targetWindowMs)
    removeBefore(samples, cutoff, (sample) => sample.at)
    removeBefore(markers, cutoff, (marker) => marker.at)
    removeUnreferencedHistoricalProcesses(processes, samples)
    removeUnreferencedHistoricalOwners(owners, processes, markers)

    let snapshot = buildSnapshot(at)
    let retainedBytes = byteLength(snapshot)
    while (retainedBytes > maxBytes && (samples.length > 0 || markers.length > 0)) {
      pressureTruncated = true
      const oldestAt = Math.min(
        samples[0]?.at ?? Number.POSITIVE_INFINITY,
        markers[0]?.at ?? Number.POSITIVE_INFINITY,
      )
      removeThrough(samples, oldestAt, (sample) => sample.at)
      removeThrough(markers, oldestAt, (marker) => marker.at)
      removeUnreferencedHistoricalProcesses(processes, samples)
      removeUnreferencedHistoricalOwners(owners, processes, markers)
      snapshot = buildSnapshot(at)
      retainedBytes = byteLength(snapshot)
    }
    stats.retainedBytes = retainedBytes
    stats.retainedProcesses = processes.size
    stats.retainedSamples = samples.length
    stats.retainedMarkers = markers.length
    return snapshot
  }

  function buildSnapshot(at: number): LocalDiagnostics.RetainedSnapshot {
    const retainedFromAt = Math.min(
      samples[0]?.at ?? Number.POSITIVE_INFINITY,
      markers[0]?.at ?? Number.POSITIVE_INFINITY,
      at,
    )
    const snapshotProcesses = [...processes.values()].map((process) => ({
      ...process,
      actionEligibility: actions.eligibility(
        process,
        process.ownerId ? owners.get(process.ownerId) : undefined,
      ),
    }))
    return {
      version: 1,
      generation,
      capturedAt: at,
      retainedFromAt,
      targetWindowMs,
      retention: pressureTruncated ? { state: "truncated", reason: "memory-pressure" } : { state: "complete" },
      owners: [...owners.values()],
      processes: snapshotProcesses,
      samples: samples.slice(),
      sources: [
        sourceStatus,
        ...(options.source.statuses?.().filter((status) => status.source !== options.source.id) ?? []),
      ],
      markers: markers.slice(),
      interval: aggregateInterval({
        startAt: retainedFromAt,
        endAt: at,
        samples,
        processes: snapshotProcesses,
        markers,
      }),
    }
  }

  function notify(snapshot: LocalDiagnostics.RetainedSnapshot) {
    if (listeners.size === 0) return
    listeners.forEach((listener) => {
      try {
        listener(snapshot)
      } catch {
        listeners.delete(listener)
      }
    })
  }

  return {
    markInteractive() {
      if (disposed || interactive) return
      interactive = true
      if (inFlight || timer === undefined) return
      clock.clearTimeout(timer)
      timer = undefined
      schedulePeriodic()
    },
    getSnapshot() {
      return trim(clock.now())
    },
    getStats() {
      return {
        ...stats,
        averageSourceDurationMs:
          stats.sourceAttempts > 0 ? stats.totalSourceDurationMs / stats.sourceAttempts : 0,
        ...(options.source.getStats?.() ?? {}),
      }
    },
    subscribe(listener: (snapshot: LocalDiagnostics.RetainedSnapshot) => void) {
      if (disposed) return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    requestSample(reason: SampleReason = "manual") {
      if (reason === "lifecycle") {
        if (inFlight) {
          burstPending = true
          return
        }
        scheduleBurst()
        return
      }
      runCollection(reason)
    },
    recordLifecycle,
    recordOwnerEvent(event: DiagnosticsOwnerEvent, operation?: OwnerOperation) {
      if (event.type === "owner-registered") {
        const current = observedOwnerRoots.get(event.descriptor.ownerId)
        current?.unregister()
        observedOwnerRoots.set(event.descriptor.ownerId, {
          descriptor: event.descriptor,
          unregister: registerObservedRoot(event.descriptor),
        })
        actions.register(event.descriptor, operation)
        owners.set(event.descriptor.ownerId, {
          id: event.descriptor.ownerId,
          kind: event.descriptor.kind,
          label: event.descriptor.label,
          launchId: event.descriptor.launchId,
          ...(event.descriptor.parentOwnerId ? { parentOwnerId: event.descriptor.parentOwnerId } : {}),
          access: event.descriptor.access ?? "local",
          lifecycle: "current",
          ...(event.descriptor.workspaceId ? { workspaceId: event.descriptor.workspaceId } : {}),
          ...(event.descriptor.directory ? { directory: event.descriptor.directory } : {}),
          ...(event.descriptor.sessionId ? { sessionId: event.descriptor.sessionId } : {}),
          ...(event.descriptor.harnessId ? { harnessId: event.descriptor.harnessId } : {}),
          ...(event.descriptor.attributionConfidence
            ? { attributionConfidence: event.descriptor.attributionConfidence }
            : {}),
        })
        recordLifecycle({ at: event.at, event: "owner-started", ownerId: event.descriptor.ownerId })
        return
      }
      const current = observedOwnerRoots.get(event.ownerId)
      if (!current || current.descriptor.ownerGeneration !== event.ownerGeneration) return
      if (event.type === "owner-updated") {
        actions.update(event)
        if (event.lifecycle !== "detached") {
          if (event.pid && current.descriptor.pid !== event.pid) {
            current.unregister()
            current.descriptor = { ...current.descriptor, pid: event.pid }
            current.unregister = registerObservedRoot(current.descriptor)
          }
          recordLifecycle({ at: event.at, event: "runtime-ready", ownerId: event.ownerId })
          return
        }
        current.unregister()
        observedOwnerRoots.delete(event.ownerId)
        const owner = owners.get(event.ownerId)
        if (owner) owners.set(owner.id, { ...owner, lifecycle: "historical" })
        recordLifecycle({ at: event.at, event: "owner-exited", ownerId: event.ownerId })
        return
      }
      actions.exit(event.ownerId, event.ownerGeneration)
      current.unregister()
      observedOwnerRoots.delete(event.ownerId)
      const owner = owners.get(event.ownerId)
      if (owner) owners.set(owner.id, { ...owner, lifecycle: "historical" })
      const measured = samples.some(
        (sample) => processes.get(sample.processId)?.ownerId === event.ownerId,
      )
      appendMarker({
        type: "churn",
        id: nextMarkerId(),
        at: event.at,
        ownerId: event.ownerId,
        launched: 1,
        exited: 1,
        shortestDurationMs: event.observedLifetimeMs,
        longestDurationMs: event.observedLifetimeMs,
        resourceMeasurement: measured
          ? { state: "measured" }
          : { state: "unmeasured", reason: "not-sampled" },
      })
      recordLifecycle({ at: event.at, event: "owner-exited", ownerId: event.ownerId })
    },
    prepareAction(request: LocalDiagnostics.ActionRequest) {
      const prepared = actions.claim(request)
      if (!prepared.ok) return prepared
      recordLifecycle({
        event: "action-requested",
        ownerId: prepared.claim.ownerId,
        processId: prepared.claim.identity.id,
        action: prepared.claim.action,
      })
      return prepared
    },
    cancelAction(
      claim: ActionClaim,
      code: "user-cancelled" | "stale-generation" = "user-cancelled",
    ) {
      recordLifecycle({
        event: "action-failed",
        ownerId: claim.ownerId,
        processId: claim.identity.id,
        action: claim.action,
        outcome: "rejected",
      })
      return {
        ok: false as const,
        action: claim.action,
        code,
      }
    },
    async executeAction(claim: ActionClaim): Promise<LocalDiagnostics.ActionResult> {
      const result = await actions.execute({
        claim,
        resolveProcess: (processId) => processes.get(processId),
        revalidate: (identity) => options.source.revalidateIdentity?.(identity) ?? Promise.resolve(false),
      }).catch(() => ({ ok: false as const, code: "operation-failed" as const }))
      if (!result.ok) {
        recordLifecycle({
          event: "action-failed",
          ownerId: claim.ownerId,
          processId: claim.identity.id,
          action: claim.action,
          outcome: "failed",
        })
        return { ok: false, action: claim.action, code: result.code }
      }
      const markerId = recordLifecycle({
        event: "action-completed",
        ownerId: claim.ownerId,
        processId: claim.identity.id,
        action: claim.action,
        outcome: "succeeded",
      })
      return {
        ok: true,
        action: claim.action,
        completedAt: clock.now(),
        markerId: markerId ?? `${generation}-disposed`,
      }
    },
    getGeneration() {
      return generation
    },
    registerUtilityProcess(utilityProcess: UtilityProcessLike, root: Omit<ElectronRoot, "pid">) {
      const source = options.source as Partial<ElectronDiagnosticsSource>
      let unregisterRoot: (() => void) | undefined
      let registeredPid: number | undefined
      const register = () => {
        if (!utilityProcess.pid || !source.registerRoot) return
        if (registeredPid === utilityProcess.pid) return
        unregisterRoot?.()
        registeredPid = utilityProcess.pid
        unregisterRoot = source.registerRoot({
          ...root,
          pid: utilityProcess.pid,
        })
        owners.set(root.ownerId, {
          id: root.ownerId,
          kind: root.ownerKind,
          label: root.label,
          launchId: root.launchId,
          access: "local",
          lifecycle: "current",
        })
        recordLifecycle({
          event: "server-starting",
          ownerId: root.ownerId,
        })
      }
      const onExit = () => {
        unregisterRoot?.()
        unregisterRoot = undefined
        registeredPid = undefined
        const running = [...processes.values()].find(
          (process) => process.identity.launchId === root.launchId && process.lifecycle !== "exited",
        )
        if (running) markProcessExited(running.identity.id, clock.now())
        const owner = owners.get(root.ownerId)
        if (owner) owners.set(owner.id, { ...owner, lifecycle: "historical" })
        if (!running) {
          recordLifecycle({
            event: "process-exited",
            ownerId: root.ownerId,
          })
          return
        }
        notify(trim(clock.now()))
        scheduleBurst()
      }
      utilityProcess.on("spawn", register)
      utilityProcess.once("exit", onExit)
      register()
      return () => {
        utilityProcess.off?.("spawn", register)
        unregisterRoot?.()
      }
    },
    dispose() {
      if (disposed) return
      recordLifecycle({ event: "app-shutdown" })
      disposed = true
      if (timer !== undefined) clock.clearTimeout(timer)
      if (burstTimer !== undefined) clock.clearTimeout(burstTimer)
      timer = undefined
      burstTimer = undefined
      listeners.clear()
      observedOwnerRoots.forEach((root) => root.unregister())
      observedOwnerRoots.clear()
      actions.revokeAll()
      options.source.dispose?.()
    },
  }

  function registerObservedRoot(
    descriptor: Extract<DiagnosticsOwnerEvent, { type: "owner-registered" }>["descriptor"],
  ) {
    if (!descriptor.pid || !options.source.registerRoot) return () => undefined
    return options.source.registerRoot({
      pid: descriptor.pid,
      launchId: descriptor.launchId,
      ownerId: descriptor.ownerId,
      ownerKind: descriptor.kind,
      role: descriptor.role,
      label: descriptor.label,
    })
  }
}

export function aggregateInterval(input: {
  startAt: number
  endAt: number
  samples: LocalDiagnostics.MetricPoint[]
  processes: LocalDiagnostics.ProcessRecord[]
  markers: LocalDiagnostics.Marker[]
}): LocalDiagnostics.IntervalSummary {
  const points = new Map<string, LocalDiagnostics.MetricPoint>()
  input.samples
    .filter((sample) => sample.at >= input.startAt && sample.at <= input.endAt)
    .forEach((sample) => {
      const key = `${String(sample.at)}:${sample.processId}`
      const existing = points.get(key)
      points.set(key, existing ? mergeMetricPoints(existing, sample) : sample)
    })
  const filtered = [...points.values()]
  const processById = new Map(input.processes.map((process) => [process.identity.id, process]))
  const byTimestamp = Map.groupBy(filtered, (sample) => sample.at)
  const timestamps = [...byTimestamp.keys()].sort((a, b) => a - b)
  const totalsByAt = timestamps.map((at) => {
    const atPoints = byTimestamp.get(at) ?? []
    // Clamp the SUM: each process reading is individually ≤100, but the
    // per-process samples are taken milliseconds apart, so a busy machine can
    // sum to fractionally over 100 machine-percent — and the transport DTO
    // (rightly) rejects >100. Observed 100.02 on the Linux release runner.
    const cpu = sumAvailable(atPoints.map((sample) => sample.cpuMachinePercent))
    return {
      at,
      cpu: cpu.state === "available" ? { ...cpu, value: Math.min(100, cpu.value) } : cpu,
      rss: sumAvailable(atPoints.map((sample) => sample.rssBytes)),
    }
  })
  const totalCpuValues = completeValues(filtered.map((point) => point.cpuMachinePercent))
  const totalCpu = totalCpuValues?.reduce((sum, value) => sum + value, 0)
  const grouped = Map.groupBy(filtered, (sample) => sample.processId)
  const contributors = [...grouped.entries()]
    .map(([processId, processPoints]) => {
      // A process's OWN peak and RSS delta use the readings that exist.
      // Every CPU reading is a delta, so a process's first sample never has
      // one, and on Windows the CIM cold start (22-47s) keeps that
      // warming-up sample inside the retention window for the whole run —
      // an all-or-nothing peak would rank nothing on that platform no
      // matter how much CPU the process burned.
      //
      // SHARE stays all-or-nothing (below, via completeValues): a share is a
      // fraction of a cross-process total, and computing one from a partial
      // numerator over a total that excludes the same gaps would overstate
      // it. Missing data must widen error bars, not invent precision.
      const cpuValues = availableValues(processPoints.map((point) => point.cpuMachinePercent))
      const rssValues = availableValues(processPoints.map((point) => point.rssBytes))
      const completeCpuValues = completeValues(processPoints.map((point) => point.cpuMachinePercent))
      const processCpu = completeCpuValues?.reduce((sum, value) => sum + value, 0)
      return {
        processId,
        ...(processById.get(processId)?.ownerId ? { ownerId: processById.get(processId)!.ownerId } : {}),
        peakCpuMachinePercent: maxReading(cpuValues),
        cpuSharePercent:
          totalCpu !== undefined && totalCpu > 0 && processCpu !== undefined
            ? { state: "available" as const, value: Math.min(100, (processCpu / totalCpu) * 100) }
            : { state: "unavailable" as const, reason: "not-sampled" as const },
        peakRssBytes: maxByteReading(rssValues),
        rssChangeBytes:
          rssValues.length > 1
            ? { state: "available" as const, value: rssValues.at(-1)! - rssValues[0]! }
            : { state: "unavailable" as const, reason: "not-sampled" as const },
      }
    })
    .sort((a, b) => readingValue(b.peakCpuMachinePercent) - readingValue(a.peakCpuMachinePercent))

  const current = totalsByAt.at(-1)
  const rssTotals = completeValues(totalsByAt.map((total) => total.rss))
  const cpuTotals = completeValues(totalsByAt.map((total) => total.cpu))
  return {
    startAt: input.startAt,
    endAt: input.endAt,
    sampleCount: timestamps.length,
    totals: {
      currentCpuMachinePercent: current?.cpu ?? { state: "unavailable", reason: "not-sampled" },
      peakCpuMachinePercent: maxReading(cpuTotals ?? []),
      currentRssBytes: current?.rss ?? { state: "unavailable", reason: "not-sampled" },
      peakRssBytes: maxByteReading(rssTotals ?? []),
      rssChangeBytes:
        rssTotals && rssTotals.length > 1
          ? { state: "available", value: rssTotals.at(-1)! - rssTotals[0]! }
          : { state: "unavailable", reason: "not-sampled" },
    },
    contributors,
    churn: summarizeChurn(input.markers, input.startAt, input.endAt),
  }
}

function mergeMetricPoints(
  current: LocalDiagnostics.MetricPoint,
  incoming: LocalDiagnostics.MetricPoint,
): LocalDiagnostics.MetricPoint {
  return {
    at: incoming.at,
    processId: incoming.processId,
    cpuMachinePercent:
      current.cpuMachinePercent.state === "available" ? current.cpuMachinePercent : incoming.cpuMachinePercent,
    rssBytes: current.rssBytes.state === "available" ? current.rssBytes : incoming.rssBytes,
  }
}

function sumAvailable(
  readings: Array<LocalDiagnostics.CpuMachinePercent | LocalDiagnostics.ByteReading>,
): LocalDiagnostics.CpuMachinePercent | LocalDiagnostics.ByteReading {
  const values = completeValues(readings)
  if (!values || values.length === 0) return { state: "unavailable", reason: "not-sampled" }
  return { state: "available", value: values.reduce((sum, value) => sum + value, 0) }
}

/**
 * The readings that exist, however many that is. For a SINGLE series where a
 * gap means "not measured yet" rather than "this datum is wrong" — a peak, or
 * a delta across the samples that do have values. Use completeValues instead
 * whenever the result combines series across processes, where a gap in one
 * would silently bias the combination.
 */
function availableValues(
  readings: Array<LocalDiagnostics.CpuMachinePercent | LocalDiagnostics.ByteReading>,
) {
  return readings
    .filter((reading): reading is Extract<typeof reading, { state: "available" }> => reading.state === "available")
    .map((reading) => reading.value)
}

function completeValues(
  readings: Array<LocalDiagnostics.CpuMachinePercent | LocalDiagnostics.ByteReading>,
) {
  const values = readings
    .filter((reading): reading is Extract<typeof reading, { state: "available" }> => reading.state === "available")
    .map((reading) => reading.value)
  if (values.length !== readings.length) return
  return values
}

function maxReading(values: number[]): LocalDiagnostics.CpuMachinePercent {
  if (values.length === 0) return { state: "unavailable", reason: "not-sampled" }
  return { state: "available", value: Math.min(100, Math.max(...values)) }
}

function maxByteReading(values: number[]): LocalDiagnostics.ByteReading {
  if (values.length === 0) return { state: "unavailable", reason: "not-sampled" }
  return { state: "available", value: Math.max(...values) }
}

function readingValue(reading: LocalDiagnostics.CpuMachinePercent) {
  return reading.state === "available" ? reading.value : -1
}

function summarizeChurn(markers: LocalDiagnostics.Marker[], startAt: number, endAt: number) {
  const churn = markers.filter(
    (marker): marker is LocalDiagnostics.ChurnMarker =>
      marker.type === "churn" && marker.at >= startAt && marker.at <= endAt,
  )
  return [...Map.groupBy(churn, (marker) => marker.ownerId).entries()].map(([ownerId, ownerMarkers]) => ({
    ownerId,
    launched: ownerMarkers.reduce((sum, marker) => sum + marker.launched, 0),
    exited: ownerMarkers.reduce((sum, marker) => sum + marker.exited, 0),
    resourceMeasurement: ownerMarkers.every((marker) => marker.resourceMeasurement.state === "measured")
      ? ("measured" as const)
      : ("unmeasured" as const),
  }))
}

function removeBefore<T>(items: T[], cutoff: number, at: (item: T) => number) {
  const firstRetained = items.findIndex((item) => at(item) >= cutoff)
  if (firstRetained === -1) {
    items.length = 0
    return
  }
  if (firstRetained > 0) items.splice(0, firstRetained)
}

function removeThrough<T>(items: T[], cutoff: number, at: (item: T) => number) {
  const firstRetained = items.findIndex((item) => at(item) > cutoff)
  if (firstRetained === -1) {
    items.length = 0
    return
  }
  if (firstRetained > 0) items.splice(0, firstRetained)
}

function removeUnreferencedHistoricalProcesses(
  processes: Map<string, LocalDiagnostics.ProcessRecord>,
  samples: LocalDiagnostics.MetricPoint[],
) {
  const referenced = new Set(samples.map((sample) => sample.processId))
  processes.forEach((process, id) => {
    if (process.lifecycle !== "exited" || referenced.has(id)) return
    processes.delete(id)
  })
}

function removeUnreferencedHistoricalOwners(
  owners: Map<string, LocalDiagnostics.OwnerIdentity>,
  processes: Map<string, LocalDiagnostics.ProcessRecord>,
  markers: LocalDiagnostics.Marker[],
) {
  const referenced = new Set([
    ...[...processes.values()].flatMap((process) => (process.ownerId ? [process.ownerId] : [])),
    ...markers.flatMap((marker) => ("ownerId" in marker && marker.ownerId ? [marker.ownerId] : [])),
  ])
  owners.forEach((owner, id) => {
    if (owner.lifecycle !== "historical" || referenced.has(id)) return
    owners.delete(id)
  })
}

function byteLength(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value))
}

const realClock: DiagnosticsClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
}
