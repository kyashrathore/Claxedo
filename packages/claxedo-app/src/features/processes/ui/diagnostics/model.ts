import type { LocalDiagnostics } from "../../data/local-diagnostics"

export type DiagnosticsRange = {
  startAt: number
  endAt: number
}

export type DiagnosticsSeriesPoint = {
  at: number
  cpu: number | undefined
  rssBytes: number | undefined
  memoryImpactBytes: number | undefined
  memoryImpactComplete: boolean
}

export type DiagnosticsContributor = {
  owner: LocalDiagnostics.OwnerIdentity
  processes: LocalDiagnostics.ProcessRecord[]
  currentCpu: number | undefined
  peakCpu: number | undefined
  currentRssBytes: number | undefined
  peakRssBytes: number | undefined
  rssChangeBytes: number | undefined
  currentMemoryImpactBytes: number | undefined
  peakMemoryImpactBytes: number | undefined
  memoryImpactChangeBytes: number | undefined
  currentMemoryImpactComplete: boolean
  confidence: "direct" | "shared" | "inferred" | "historical"
  actionEligibility: LocalDiagnostics.ActionEligibility
}

export function liveRange(snapshot: LocalDiagnostics.RetainedSnapshot): DiagnosticsRange {
  return { startAt: snapshot.retainedFromAt, endAt: snapshot.capturedAt }
}

export function buildDiagnosticsModel(snapshot: LocalDiagnostics.RetainedSnapshot) {
  const bounds = liveRange(snapshot)
  const processes = new Map(snapshot.processes.map((process) => [process.identity.id, process]))
  const points = snapshot.samples.filter((point) => point.at >= bounds.startAt && point.at <= bounds.endAt)
  const byTimestamp = Map.groupBy(points, (point) => point.at)
  const series = [...byTimestamp.entries()]
    .sort(([a], [b]) => a - b)
    .map(([at, samples]) => ({
      at,
      cpu: sum(samples.flatMap((sample) =>
        sample.cpuMachinePercent.state === "available" ? [sample.cpuMachinePercent.value] : [])),
      rssBytes: sum(samples.flatMap((sample) =>
        sample.rssBytes.state === "available" ? [sample.rssBytes.value] : [])),
      ...memoryImpact(samples),
    }))
  const memoryImpactKinds = [...new Set(points.flatMap((point) =>
    point.memoryImpact ? [point.memoryImpact.kind] : []))].sort()
  const ownerById = new Map(snapshot.owners.map((owner) => [owner.id, owner]))
  const ownerPoints = Map.groupBy(
    points.filter((point) => processes.get(point.processId)?.ownerId),
    (point) => processes.get(point.processId)!.ownerId!,
  )
  const retainedProcessIds = new Set(points.map((point) => point.processId))
  const processesByOwner = Map.groupBy(
    snapshot.processes.filter(
      (process) => process.ownerId && retainedProcessIds.has(process.identity.id),
    ),
    (process) => process.ownerId!,
  )
  const contributors = [...ownerPoints.entries()]
    .flatMap(([ownerId, samples]) => {
      const owner = ownerById.get(ownerId)
      if (!owner) return []
      const ownedProcesses = processesByOwner.get(ownerId) ?? []
      const values = [...Map.groupBy(samples, (sample) => sample.at).entries()]
        .sort(([a], [b]) => a - b)
        .map(([, at]) => {
          const impact = memoryImpact(at)
          return {
            cpu: sum(at.flatMap((point) =>
              point.cpuMachinePercent.state === "available" ? [point.cpuMachinePercent.value] : [])),
            rss: sum(at.flatMap((point) =>
              point.rssBytes.state === "available" ? [point.rssBytes.value] : [])),
            memoryImpact: impact.memoryImpactBytes,
            memoryImpactComplete: impact.memoryImpactComplete,
          }
        })
      const cpu = values.map((value) => value.cpu)
      const rss = values.map((value) => value.rss)
      const memory = values.map((value) => value.memoryImpact)
      return [{
        owner,
        processes: ownedProcesses,
        currentCpu: last(cpu),
        peakCpu: max(cpu),
        currentRssBytes: last(rss),
        peakRssBytes: max(rss),
        rssChangeBytes: change(rss),
        currentMemoryImpactBytes: last(memory),
        peakMemoryImpactBytes: max(memory),
        memoryImpactChangeBytes: change(memory),
        currentMemoryImpactComplete: values.at(-1)?.memoryImpactComplete ?? false,
        confidence: confidence(owner, ownedProcesses),
        actionEligibility: actionEligibility(ownedProcesses),
      } satisfies DiagnosticsContributor]
    })
    .sort((a, b) =>
      (b.peakCpu ?? -1) - (a.peakCpu ?? -1) ||
      (b.peakMemoryImpactBytes ?? -1) - (a.peakMemoryImpactBytes ?? -1) ||
      (b.peakRssBytes ?? -1) - (a.peakRssBytes ?? -1) ||
      a.owner.label.localeCompare(b.owner.label))
  const retainedChurn = snapshot.markers.filter(
    (marker): marker is LocalDiagnostics.ChurnMarker =>
      marker.type === "churn" && marker.at >= bounds.startAt && marker.at <= bounds.endAt,
  )

  return {
    bounds,
    series,
    memoryImpactKinds,
    contributors,
    churn: [...Map.groupBy(retainedChurn, (marker) => marker.ownerId).entries()].map(
      ([ownerId, markers]) => ({
        ownerId,
        launched: markers.reduce((total, marker) => total + marker.launched, 0),
        exited: markers.reduce((total, marker) => total + marker.exited, 0),
        resourceMeasurement: markers.every((marker) => marker.resourceMeasurement.state === "measured")
          ? ("measured" as const)
          : ("unmeasured" as const),
      }),
    ),
    markers: snapshot.markers.filter((marker) => marker.at >= bounds.startAt && marker.at <= bounds.endAt),
  }
}

function memoryImpact(samples: LocalDiagnostics.MetricPoint[]) {
  const readings = samples.flatMap((sample) =>
    sample.memoryImpact?.bytes.state === "available" ? [sample.memoryImpact.bytes.value] : [])
  return {
    memoryImpactBytes: sum(readings),
    memoryImpactComplete: readings.length === samples.length,
  }
}

export function ownerGroup(kind: LocalDiagnostics.OwnerKind) {
  if (["app", "electron-main", "renderer", "gpu", "utility"].includes(kind)) return "Desktop / Electron"
  if (["server", "runtime"].includes(kind)) return "Claxedo server and workspace activity"
  if (["harness", "probe", "cli"].includes(kind)) return "Harnesses and CLI"
  if (kind === "mcp") return "MCP"
  if (["pty", "session-shell"].includes(kind)) return "Terminals and shell tools"
  if (kind === "managed-process") return "Managed processes"
  if (kind === "sidecar") return "Sidecars"
  return "Other local processes"
}

function sum(values: number[]) {
  return values.length > 0 ? values.reduce((total, value) => total + value, 0) : undefined
}

function max(values: Array<number | undefined>) {
  const available = values.filter((value): value is number => value !== undefined)
  return available.length > 0 ? Math.max(...available) : undefined
}

function last(values: Array<number | undefined>) {
  return values.findLast((value): value is number => value !== undefined)
}

function change(values: Array<number | undefined>) {
  const available = values.filter((value): value is number => value !== undefined)
  return available.length > 0 ? available.at(-1)! - available[0]! : undefined
}

function confidence(
  owner: LocalDiagnostics.OwnerIdentity,
  processes: LocalDiagnostics.ProcessRecord[],
): DiagnosticsContributor["confidence"] {
  if (owner.lifecycle === "historical") return "historical"
  if (owner.kind === "runtime") return "shared"
  if (processes.some((process) => process.identity.creation.state === "available")) return "direct"
  return "inferred"
}

function actionEligibility(processes: LocalDiagnostics.ProcessRecord[]): LocalDiagnostics.ActionEligibility {
  return processes.find(
    (process): process is LocalDiagnostics.ProcessRecord & {
      actionEligibility: Extract<LocalDiagnostics.ActionEligibility, { state: "eligible" }>
    } => process.actionEligibility.state === "eligible",
  )?.actionEligibility ?? processes[0]?.actionEligibility ?? {
    state: "ineligible",
    reason: "unregistered-owner",
  }
}
