import type { LocalDiagnostics } from "@claxedo/app/process-diagnostics-contract"

import type { ElectronDiagnosticsSource, ElectronRoot } from "./electron-source"
import { processIdentity } from "./process-identity"
import {
  createIsolatedPosixProcessMetricsWorker,
  createWindowsCimQuery,
  createWindowsProcessMetricsWorker,
  type ProcessMetricSample,
  type ProcessMetricsWorker,
  type ProcessTreeEntry,
} from "./process-metrics-worker"
import type { DiagnosticsObservation, DiagnosticsSource } from "./profiler"
import type { WslDiagnosticsSource } from "./wsl-source"
import windowsCimEncodedCommand from "./windows-cim-worker.ps1?encoded"

const RECONCILE_INTERVAL_MS = 30_000

export type ProcessMetricsSource = DiagnosticsSource & {
  registerRoot(root: ElectronRoot): () => void
  revalidateIdentity(identity: LocalDiagnostics.ProcessIdentity): Promise<boolean>
  registerWslRoot?: WslDiagnosticsSource["registerRoot"]
  getStats(): Record<string, number>
}

export function createProcessMetricsSource(options: {
  electron: ElectronDiagnosticsSource
  platform?: NodeJS.Platform
  worker?: ProcessMetricsWorker
  workerPath?: string
  wsl?: WslDiagnosticsSource
  reconcileIntervalMs?: number
  random?: () => number
}): ProcessMetricsSource {
  const platform = options.platform ?? process.platform
  const worker =
    options.worker ??
    (platform === "darwin" || platform === "linux"
      ? createIsolatedPosixProcessMetricsWorker({ platform, workerPath: options.workerPath })
      : platform === "win32"
        ? createLazyWindowsWorker()
        : unsupportedWorker)
  const sourceId: LocalDiagnostics.SourceId =
    platform === "darwin" ? "macos-ps" : platform === "linux" ? "linux-proc" : "windows-cim"
  const roots = new Map<number, ElectronRoot>()
  const electronByPid = new Map<number, DiagnosticsObservation>()
  const last = new Map<string, DiagnosticsObservation>()
  const pending = new Map<string, DiagnosticsObservation>()
  const darwinGenerations = new Map<number, number>()
  let entries: ProcessTreeEntry[] = []
  let reconcileAt = Number.NEGATIVE_INFINITY
  let rootsDirty = false
  let rootsRevision = 0
  let hostInFlight = false
  let hostRetryAt = Number.NEGATIVE_INFINITY
  let consecutiveHostFailures = 0
  let disposed = false
  const stats = {
    hostCollections: 0,
    lastHostDurationMs: 0,
    maxHostDurationMs: 0,
    totalHostDurationMs: 0,
    reconciliations: 0,
    lastReconciliationDurationMs: 0,
    maxReconciliationDurationMs: 0,
    totalReconciliationDurationMs: 0,
  }
  const supported = platform === "darwin" || platform === "linux" || platform === "win32"
  let hostStatus: LocalDiagnostics.SourceStatus = supported
    ? { ...sourceStatusBase(), state: "warming-up" }
    : { ...sourceStatusBase(), accuracy: "unsupported", state: "unsupported", reason: "unsupported" }
  let ancestryStatus: LocalDiagnostics.SourceStatus | undefined =
    platform === "win32"
      ? { ...ancestryStatusBase(), state: "warming-up" }
      : undefined

  return {
    id: "electron",
    domain: "host",
    accuracy: "native",
    capabilities: {
      cpu: true,
      rss: true,
      ancestry: true,
      creationIdentity: true,
      actionIdentity: platform === "linux" || platform === "win32",
    },
    statuses() {
      return [hostStatus, ...(ancestryStatus ? [ancestryStatus] : []), ...(options.wsl?.statuses?.() ?? [])]
    },
    getStats() {
      return {
        ...stats,
        averageHostDurationMs:
          stats.hostCollections > 0 ? stats.totalHostDurationMs / stats.hostCollections : 0,
        averageReconciliationDurationMs:
          stats.reconciliations > 0 ? stats.totalReconciliationDurationMs / stats.reconciliations : 0,
      }
    },
    collect(at) {
      const electron = options.electron.collect(at)
      if (electron instanceof Promise) throw new Error("Electron diagnostics must collect synchronously")
      electronByPid.clear()
      electron.forEach((observation) => electronByPid.set(observation.process.identity.pid, observation))
      triggerHost(at)
      options.wsl?.requestCollection(at)
      const external = drainExternal(at)
      return mergeByProcess(electron, [...external, ...(options.wsl?.drain(at) ?? [])])
    },
    registerRoot(root) {
      roots.set(root.pid, root)
      rootsDirty = true
      rootsRevision++
      const unregisterElectron = options.electron.registerRoot(root)
      return () => {
        if (roots.get(root.pid)?.launchId !== root.launchId) return
        roots.delete(root.pid)
        entries = entries.filter((entry) => entry.rootPid !== root.pid)
        ;[...last.entries(), ...pending.entries()].forEach(([key, observation]) => {
          if (observation.owner.id === root.ownerId) {
            last.delete(key)
            pending.delete(key)
          }
        })
        rootsDirty = true
        rootsRevision++
        unregisterElectron()
      }
    },
    async revalidateIdentity(identity) {
      if (
        identity.domain !== "host" ||
        identity.creation.state !== "available" ||
        !(
          (platform === "linux" && identity.creation.source === "linux-proc") ||
          (platform === "win32" && identity.creation.source === "windows-cim")
        )
      ) return false
      const current = await worker.probeCreation(identity.pid)
      return (
        current.state === "available" &&
        current.source === identity.creation.source &&
        current.value === identity.creation.value
      )
    },
    ...(options.wsl?.registerRoot ? { registerWslRoot: options.wsl.registerRoot } : {}),
    dispose() {
      if (disposed) return
      disposed = true
      worker.dispose()
      options.electron.dispose?.()
      options.wsl?.dispose()
      roots.clear()
      last.clear()
      pending.clear()
      entries = []
    },
  }

  function triggerHost(at: number) {
    const electronFallback = [...electronByPid.values()].filter(
      (observation) =>
        observation.point.cpuMachinePercent.state !== "available" ||
        observation.point.rssBytes.state !== "available",
    )
    if (
      disposed ||
      hostInFlight ||
      at < hostRetryAt ||
      hostStatus.state === "unsupported"
    )
      return
    if (roots.size === 0 && electronFallback.length === 0) {
      hostStatus = { ...sourceStatusBase(), state: "healthy", lastSuccessAt: at }
      return
    }
    hostInFlight = true
    const reconcile =
      roots.size > 0 &&
      (rootsDirty || entries.length === 0 || at - reconcileAt >= (options.reconcileIntervalMs ?? RECONCILE_INTERVAL_MS))
    const electronAtStart = new Map(electronByPid)
    const fallbackPids = new Set(electronFallback.map((observation) => observation.process.identity.pid))
    const revisionAtStart = rootsRevision
    const rootsAtStart = new Map(roots)
    const hostStartedAt = performance.now()
    void (async () => {
      let reconciliationFailed = false
      if (reconcile) {
        const reconciliationStartedAt = performance.now()
        try {
          const result = await worker.reconcile([...rootsAtStart.keys()])
          if (disposed) return
          const reconciledEntries = result.entries.filter((entry) => {
            const started = rootsAtStart.get(entry.rootPid)
            return !!started && roots.get(entry.rootPid)?.launchId === started.launchId
          })
          if (platform === "darwin") {
            const previous = new Set(entries.map((entry) => entry.pid))
            reconciledEntries.forEach((entry) => {
              if (previous.has(entry.pid)) return
              darwinGenerations.set(entry.pid, (darwinGenerations.get(entry.pid) ?? 0) + 1)
            })
          }
          entries = reconciledEntries
          const alive = new Set([...reconciledEntries.map((entry) => entry.pid), ...electronByPid.keys()])
          last.forEach((observation, key) => {
            if (alive.has(observation.process.identity.pid)) return
            last.delete(key)
            pending.delete(key)
          })
          rootsDirty = rootsRevision !== revisionAtStart
          reconcileAt = at
          if (ancestryStatus) {
            ancestryStatus = result.truncated
              ? { ...ancestryStatusBase(), state: "degraded", reason: "source-truncated", lastSuccessAt: at }
              : { ...ancestryStatusBase(), state: "healthy", lastSuccessAt: at }
          }
        } catch {
          reconciliationFailed = true
          if (ancestryStatus) {
            ancestryStatus = {
              ...ancestryStatusBase(),
              state: "degraded",
              reason: "source-failed",
              ...("lastSuccessAt" in ancestryStatus && ancestryStatus.lastSuccessAt !== undefined
                ? { lastSuccessAt: ancestryStatus.lastSuccessAt }
                : {}),
            }
          }
          if (entries.length === 0) {
            entries = [...rootsAtStart.keys()]
              .filter((pid) => roots.get(pid)?.launchId === rootsAtStart.get(pid)?.launchId)
              .map((pid) => ({ pid, ppid: 0, rootPid: pid }))
          }
        } finally {
          const duration = performance.now() - reconciliationStartedAt
          stats.reconciliations++
          stats.lastReconciliationDurationMs = duration
          stats.maxReconciliationDurationMs = Math.max(stats.maxReconciliationDurationMs, duration)
          stats.totalReconciliationDurationMs += duration
        }
      }
      try {
        const sampledEntries = [
          ...entries,
          ...[...fallbackPids].map((pid) => ({ pid, ppid: 0, rootPid: pid })),
        ]
        const samples = await worker.sample(
          [...new Map(sampledEntries.map((entry) => [entry.pid, entry])).values()],
          at,
        )
        if (disposed) return
        const contexts = samples
          .flatMap((sample) => {
            const electron = electronAtStart.get(sample.pid)
            if (electron && electronByPid.get(sample.pid)?.process.identity.id !== electron.process.identity.id)
              return []
            const root = roots.get(sample.rootPid)
            if (!root && !fallbackPids.has(sample.pid)) return []
            const darwinSeries =
              platform === "darwin" && sample.creation.state === "unavailable" && root
                ? `${root.launchId}:darwin:${String(darwinGenerations.get(sample.pid) ?? 1)}`
                : undefined
            return [{
              sample,
              electron,
              identity: identityFor(sample, roots, electron, darwinSeries),
            }]
          })
        const identities = new Map(contexts.map((context) => [context.sample.pid, context.identity]))
        contexts
          .map((context) =>
            observationFor(
              context.sample,
              at,
              roots,
              context.identity,
              context.electron,
              identities.get(context.sample.ppid)?.id,
            ))
          .forEach((observation) => {
            pending.set(processKey(observation), observation)
            last.set(processKey(observation), observation)
          })
        consecutiveHostFailures = 0
        hostRetryAt = Number.NEGATIVE_INFINITY
        hostStatus =
          reconciliationFailed && !ancestryStatus
            ? { ...sourceStatusBase(), state: "degraded", reason: "source-failed", lastSuccessAt: at }
            : { ...sourceStatusBase(), state: "healthy", lastSuccessAt: at }
      } catch {
        if (disposed) return
        consecutiveHostFailures++
        hostRetryAt =
          at +
          Math.min(30_000, 500 * 2 ** Math.min(6, consecutiveHostFailures - 1)) +
          Math.floor((options.random?.() ?? Math.random()) * 250)
        hostStatus = {
          ...sourceStatusBase(),
          state: "degraded",
          reason: "source-failed",
          ...("lastSuccessAt" in hostStatus && hostStatus.lastSuccessAt !== undefined
            ? { lastSuccessAt: hostStatus.lastSuccessAt }
            : {}),
        }
      } finally {
        const duration = performance.now() - hostStartedAt
        stats.hostCollections++
        stats.lastHostDurationMs = duration
        stats.maxHostDurationMs = Math.max(stats.maxHostDurationMs, duration)
        stats.totalHostDurationMs += duration
        hostInFlight = false
      }
    })()
  }

  function drainExternal(at: number) {
    const observations = [...last.entries()].flatMap(([key, observation]) => {
      const fresh = pending.get(key)
      pending.delete(key)
      if (fresh) return [{ ...fresh, point: { ...fresh.point, at } }]
      return [
        {
          ...observation,
          point: {
            at,
            processId: observation.point.processId,
            cpuMachinePercent: { state: "unavailable", reason: "not-sampled" } as const,
            rssBytes: { state: "unavailable", reason: "not-sampled" } as const,
          },
        },
      ]
    })
    return observations
  }

  function sourceStatusBase(): Pick<LocalDiagnostics.SourceStatus, "source" | "domain" | "accuracy" | "capabilities"> {
    return {
      source: sourceId,
      domain: "host" as const,
      accuracy: platform === "win32" ? ("native" as const) : ("estimated" as const),
      capabilities: {
        cpu: true,
        rss: true,
        ancestry: true,
        creationIdentity: platform === "linux" || platform === "win32",
        actionIdentity: platform === "linux" || platform === "win32",
      },
    }
  }

  function ancestryStatusBase() {
    return {
      source: "windows-process-tree" as const,
      domain: "host" as const,
      accuracy: "native" as const,
      capabilities: {
        cpu: false,
        rss: false,
        ancestry: true,
        creationIdentity: false,
        actionIdentity: false,
      },
    }
  }
}

function observationFor(
  sample: ProcessMetricSample,
  at: number,
  roots: Map<number, ElectronRoot>,
  identity: LocalDiagnostics.ProcessIdentity,
  electron?: DiagnosticsObservation,
  parentProcessId?: string,
) {
  const root = roots.get(sample.rootPid)
  const ownerId = root?.ownerId ?? `owner-external-${String(sample.rootPid)}`
  return {
    owner: {
      id: ownerId,
      kind: root?.ownerKind ?? ("external" as const),
      label: root?.label ?? "Observed local process",
      ...(root?.launchId ? { launchId: root.launchId } : {}),
      access: "local" as const,
      lifecycle: "current" as const,
    },
    process: {
      identity,
      ...(parentProcessId ? { parentProcessId } : {}),
      ownerId,
      role: sample.pid === sample.rootPid ? (root?.role ?? ("descendant" as const)) : ("descendant" as const),
      label:
        sample.pid === sample.rootPid
          ? (root?.label ?? "Observed local process")
          : `${root?.label ?? "Observed local process"} child`,
      lifecycle: "running" as const,
      actionEligibility: { state: "ineligible" as const, reason: "owner-operation-unavailable" as const },
    },
    point: {
      at,
      processId: identity.id,
      cpuMachinePercent:
        sample.cpuMachinePercent === undefined
          ? ({ state: "unavailable", reason: "warming-up" } as const)
          : ({ state: "available", value: sample.cpuMachinePercent } as const),
      rssBytes:
        sample.rssBytes === undefined
          ? ({ state: "unavailable", reason: "not-sampled" } as const)
          : ({ state: "available", value: sample.rssBytes } as const),
    },
  } satisfies DiagnosticsObservation
}

function identityFor(
  sample: ProcessMetricSample,
  roots: Map<number, ElectronRoot>,
  electron?: DiagnosticsObservation,
  seriesLaunchId?: string,
) {
  if (electron) return electron.process.identity
  const launchId = seriesLaunchId ?? roots.get(sample.rootPid)?.launchId
  return processIdentity({
    domain: "host",
    pid: sample.pid,
    creation: sample.creation,
    ...(launchId ? { launchId } : {}),
  })
}

export function mergeByProcess(
  preferred: DiagnosticsObservation[],
  fallback: DiagnosticsObservation[],
): DiagnosticsObservation[] {
  const observations = new Map(preferred.map((observation) => [processKey(observation), observation]))
  fallback.forEach((observation) => {
    const current = observations.get(processKey(observation))
    if (!current) {
      observations.set(processKey(observation), observation)
      return
    }
    if (!associated(current, observation)) return
    observations.set(processKey(observation), {
      ...current,
      process: {
        ...current.process,
        ...(current.process.parentProcessId
          ? { parentProcessId: current.process.parentProcessId }
          : observation.process.parentProcessId
            ? { parentProcessId: observation.process.parentProcessId }
            : {}),
      },
      point: {
        ...current.point,
        cpuMachinePercent:
          current.point.cpuMachinePercent.state === "available"
            ? current.point.cpuMachinePercent
            : observation.point.cpuMachinePercent,
        rssBytes: current.point.rssBytes.state === "available" ? current.point.rssBytes : observation.point.rssBytes,
      },
    })
  })
  return [...observations.values()]
}

function processKey(observation: DiagnosticsObservation) {
  return `${observation.process.identity.domain}:${String(observation.process.identity.pid)}`
}

function associated(current: DiagnosticsObservation, observation: DiagnosticsObservation) {
  if (
    current.process.identity.launchId &&
    observation.process.identity.launchId &&
    current.process.identity.launchId === observation.process.identity.launchId
  ) {
    return true
  }
  return (
    current.process.identity.creation.state === "available" &&
    observation.process.identity.creation.state === "available" &&
    current.process.identity.creation.value === observation.process.identity.creation.value
  )
}

const unsupportedWorker: ProcessMetricsWorker = {
  async reconcile() {
    return { entries: [], truncated: false }
  },
  async sample() {
    return []
  },
  async probeCreation() {
    return { state: "unavailable", reason: "unsupported" }
  },
  clear() {},
  dispose() {},
}

function createLazyWindowsWorker(): ProcessMetricsWorker {
  const cim = createWindowsCimQuery(windowsCimEncodedCommand)
  let loaded: Promise<ProcessMetricsWorker> | undefined
  const get = () =>
    // The addon is an optionalDependency whose native build bun may skip
    // (observed absent on the Windows release runner itself). It only serves
    // flag-free ancestry; absent, the worker runs with the CIM query alone
    // and ancestry degrades — the source-health machinery already reports
    // that honestly rather than the whole windows worker dying at import.
    (loaded ??= import("@vscode/windows-process-tree")
      .catch(() => undefined)
      .then((addon) =>
        createWindowsProcessMetricsWorker({
          ...(addon === undefined ? {} : { addon }),
          query: cim.query,
        }),
      ))
  return {
    async reconcile(rootPids) {
      return (await get()).reconcile(rootPids)
    },
    async sample(entries, at) {
      return (await get()).sample(entries, at)
    },
    async probeCreation(pid) {
      return (await get()).probeCreation(pid)
    },
    clear() {
      void get().then((worker) => worker.clear())
    },
    dispose() {
      cim.dispose()
      void loaded?.then((worker) => worker.dispose())
    },
  }
}
