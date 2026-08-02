import type { LocalDiagnostics } from "@claxedo/app/process-diagnostics-contract"

import type { DiagnosticsObservation, DiagnosticsSource } from "./profiler"

type CpuUsage = {
  percentCPUUsage: number
  idleWakeupsPerSecond: number
}

type ElectronMetric = {
  pid: number
  creationTime: number
  type: "Browser" | "Tab" | "Utility" | "Zygote" | "Sandbox helper" | "GPU" | "Pepper Plugin" | "Pepper Plugin Broker" | "Unknown"
  cpu: CpuUsage
  memory?: {
    workingSetSize?: number
    peakWorkingSetSize?: number
    privateBytes?: number
  }
  name?: string
  serviceName?: string
}

type ElectronWindow = {
  id: number
  isDestroyed(): boolean
  webContents: {
    id: number
    getOSProcessId(): number
  }
}

type ElectronProcess = {
  pid: number
  getCreationTime(): number | null
  getCPUUsage(): CpuUsage
  memoryUsage(): { rss: number }
}

export type ElectronRoot = {
  pid: number
  launchId: string
  ownerId: string
  ownerKind: LocalDiagnostics.OwnerKind
  role: LocalDiagnostics.ProcessRole
  label: string
}

export type ElectronDiagnosticsSource = DiagnosticsSource & {
  registerRoot(root: ElectronRoot): () => void
}

export function createElectronSource(options: {
  process: ElectronProcess
  isReady(): boolean
  getAppMetrics(): ElectronMetric[]
  getWindows(): ElectronWindow[]
}): ElectronDiagnosticsSource {
  const roots = new Map<number, ElectronRoot>()

  return {
    id: "electron",
    domain: "host",
    accuracy: "native",
    capabilities: {
      cpu: true,
      rss: true,
      ancestry: false,
      creationIdentity: true,
      actionIdentity: false,
    },
    collect(at) {
      const observations = new Map<string, DiagnosticsObservation>()
      const main = observeMain(options.process, at)
      observations.set(main.process.identity.id, main)
      if (!options.isReady()) return [...observations.values()]

      const windows = new Map(
        options
          .getWindows()
          .filter((window) => !window.isDestroyed())
          .flatMap((window) => {
            const pid = readWindowPid(window)
            if (pid <= 0) return []
            return [[pid, window] as const]
          }),
      )

      options.getAppMetrics().forEach((metric) => {
        const observation = observeMetric(metric, at, windows.get(metric.pid), roots.get(metric.pid))
        observations.set(observation.process.identity.id, observation)
      })
      return [...observations.values()]
    },
    registerRoot(root) {
      roots.set(root.pid, { ...root, label: safeLabel(root.label) })
      return () => {
        if (roots.get(root.pid)?.launchId !== root.launchId) return
        roots.delete(root.pid)
      }
    },
  }
}

function observeMain(process: ElectronProcess, at: number): DiagnosticsObservation {
  const creationTime = process.getCreationTime()
  const identity = identityFor(process.pid, creationTime, "electron-main")
  return {
    owner: {
      id: "owner-electron-main",
      kind: "electron-main",
      label: "Claxedo",
      access: "local",
      lifecycle: "current",
    },
    process: {
      identity,
      ownerId: "owner-electron-main",
      role: "main",
      label: "Claxedo main",
      lifecycle: "running",
      actionEligibility: { state: "ineligible", reason: "protected-process" },
    },
    point: {
      at,
      processId: identity.id,
      cpuMachinePercent: availableCpu(process.getCPUUsage().percentCPUUsage),
      rssBytes: { state: "available", value: Math.max(0, Math.trunc(process.memoryUsage().rss)) },
    },
  }
}

function observeMetric(
  metric: ElectronMetric,
  at: number,
  window: ElectronWindow | undefined,
  root: ElectronRoot | undefined,
): DiagnosticsObservation {
  const classification = classify(metric, window, root)
  const identity = identityFor(metric.pid, metric.creationTime, classification.fallbackIdentity, root?.launchId)
  return {
    owner: classification.owner,
    process: {
      identity,
      ownerId: classification.owner.id,
      role: classification.role,
      label: classification.label,
      lifecycle: "running",
      actionEligibility: {
        state: "ineligible",
        reason: classification.role === "main" ? "protected-process" : "owner-operation-unavailable",
      },
    },
    point: {
      at,
      processId: identity.id,
      cpuMachinePercent: availableCpu(metric.cpu.percentCPUUsage),
      rssBytes:
        typeof metric.memory?.workingSetSize === "number" && Number.isFinite(metric.memory.workingSetSize)
          ? { state: "available", value: Math.max(0, Math.trunc(metric.memory.workingSetSize * 1_024)) }
          : { state: "unavailable", reason: "unsupported" },
    },
  }
}

function classify(metric: ElectronMetric, window: ElectronWindow | undefined, root: ElectronRoot | undefined) {
  if (root) {
    return {
      fallbackIdentity: root.launchId,
      role: root.role,
      label: safeLabel(root.label),
      owner: {
        id: root.ownerId,
        kind: root.ownerKind,
        label: safeLabel(root.label),
        launchId: root.launchId,
        access: "local" as const,
        lifecycle: "current" as const,
      },
    }
  }
  if (metric.type === "Browser") {
    return {
      fallbackIdentity: "electron-main",
      role: "main" as const,
      label: "Claxedo main",
      owner: {
        id: "owner-electron-main",
        kind: "electron-main" as const,
        label: "Claxedo",
        access: "local" as const,
        lifecycle: "current" as const,
      },
    }
  }
  if (window) {
    return {
      fallbackIdentity: `renderer-${String(window.webContents.id)}`,
      role: "renderer" as const,
      label: `Claxedo window ${String(window.id)}`,
      owner: {
        id: `owner-renderer-${String(window.webContents.id)}`,
        kind: "renderer" as const,
        label: `Claxedo window ${String(window.id)}`,
        access: "local" as const,
        lifecycle: "current" as const,
      },
    }
  }

  const role = metric.type === "GPU" ? ("gpu" as const) : metric.type === "Utility" ? ("utility" as const) : ("unmapped" as const)
  const label =
    role === "gpu"
      ? "Electron GPU"
      : safeLabel(metric.name ?? metric.serviceName ?? (metric.type === "Tab" ? "Unmapped Electron tab" : `Electron ${metric.type}`))
  return {
    fallbackIdentity: `electron-${metric.type.toLowerCase()}`,
    role,
    label,
    owner: {
      id: `owner-electron-${role}`,
      kind: role,
      label,
      access: "local" as const,
      lifecycle: "current" as const,
    },
  }
}

function identityFor(pid: number, creationTime: number | null, fallback: string, launchId?: string) {
  const creation =
    typeof creationTime === "number" && Number.isFinite(creationTime) && creationTime >= 0
      ? ({ state: "available", value: String(Math.trunc(creationTime)), source: "electron" } as const)
      : ({ state: "unavailable", reason: "identity-unavailable" } as const)
  return {
    id: `host:${String(pid)}:${creation.state === "available" ? creation.value : fallback}`,
    domain: "host" as const,
    pid,
    creation,
    ...(launchId ? { launchId } : {}),
  }
}

function availableCpu(value: number): LocalDiagnostics.CpuMachinePercent {
  if (!Number.isFinite(value) || value < 0) return { state: "unavailable", reason: "source-failed" }
  return { state: "available", value: Math.min(100, value) }
}

function readWindowPid(window: ElectronWindow) {
  try {
    return window.webContents.getOSProcessId()
  } catch {
    return 0
  }
}

function safeLabel(value: string) {
  const label = value.replaceAll(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 256)
  return label || "Electron process"
}
