import type { LocalDiagnostics } from "../../data/local-diagnostics"

export type DiagnosticsRange = {
  startAt: number
  endAt: number
}

export type DiagnosticsSeriesPoint = {
  at: number
  cpu: number | undefined
  rssBytes: number | undefined
}

export type DiagnosticsContributor = {
  owner: LocalDiagnostics.OwnerIdentity
  processes: LocalDiagnostics.ProcessRecord[]
  currentCpu: number | undefined
  peakCpu: number | undefined
  currentRssBytes: number | undefined
  peakRssBytes: number | undefined
  rssChangeBytes: number | undefined
  confidence: "direct" | "shared" | "inferred" | "historical"
  actionEligibility: LocalDiagnostics.ActionEligibility
}

export function liveRange(snapshot: LocalDiagnostics.RetainedSnapshot): DiagnosticsRange {
  return { startAt: snapshot.retainedFromAt, endAt: snapshot.capturedAt }
}

export function clampRange(
  input: DiagnosticsRange,
  bounds: DiagnosticsRange,
): DiagnosticsRange {
  const startAt = Math.max(bounds.startAt, Math.min(input.startAt, bounds.endAt))
  const endAt = Math.max(startAt, Math.min(input.endAt, bounds.endAt))
  return { startAt, endAt }
}

export function moveRange(
  input: DiagnosticsRange,
  bounds: DiagnosticsRange,
  direction: -1 | 1,
  sampleTimes: number[],
  large = false,
) {
  const ordered = [...new Set(sampleTimes)].sort((a, b) => a - b)
  const baseStep = adjacentStep(ordered)
  const distance = baseStep * (large ? 5 : 1) * direction
  const width = input.endAt - input.startAt
  const nextStart = Math.max(bounds.startAt, Math.min(input.startAt + distance, bounds.endAt - width))
  return { startAt: nextStart, endAt: nextStart + width }
}

export function buildDiagnosticsModel(
  snapshot: LocalDiagnostics.RetainedSnapshot,
  selected?: DiagnosticsRange,
) {
  const bounds = liveRange(snapshot)
  const range = clampRange(selected ?? bounds, bounds)
  const processes = new Map(snapshot.processes.map((process) => [process.identity.id, process]))
  const points = snapshot.samples.filter((point) => point.at >= range.startAt && point.at <= range.endAt)
  const byTimestamp = Map.groupBy(points, (point) => point.at)
  const series = [...byTimestamp.entries()]
    .sort(([a], [b]) => a - b)
    .map(([at, samples]) => ({
      at,
      cpu: sum(samples.flatMap((sample) =>
        sample.cpuMachinePercent.state === "available" ? [sample.cpuMachinePercent.value] : [])),
      rssBytes: sum(samples.flatMap((sample) =>
        sample.rssBytes.state === "available" ? [sample.rssBytes.value] : [])),
    }))
  const ownerById = new Map(snapshot.owners.map((owner) => [owner.id, owner]))
  const ownerPoints = Map.groupBy(
    points.filter((point) => processes.get(point.processId)?.ownerId),
    (point) => processes.get(point.processId)!.ownerId!,
  )
  const selectedProcessIds = new Set(points.map((point) => point.processId))
  const processesByOwner = Map.groupBy(
    snapshot.processes.filter(
      (process) => process.ownerId && selectedProcessIds.has(process.identity.id),
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
        .map(([, at]) => ({
          cpu: sum(at.flatMap((point) =>
            point.cpuMachinePercent.state === "available" ? [point.cpuMachinePercent.value] : [])),
          rss: sum(at.flatMap((point) =>
            point.rssBytes.state === "available" ? [point.rssBytes.value] : [])),
        }))
      const cpu = values.map((value) => value.cpu)
      const rss = values.map((value) => value.rss)
      return [{
        owner,
        processes: ownedProcesses,
        currentCpu: last(cpu),
        peakCpu: max(cpu),
        currentRssBytes: last(rss),
        peakRssBytes: max(rss),
        rssChangeBytes: change(rss),
        confidence: confidence(owner, ownedProcesses),
        actionEligibility: actionEligibility(ownedProcesses),
      } satisfies DiagnosticsContributor]
    })
    .sort((a, b) =>
      (b.peakCpu ?? -1) - (a.peakCpu ?? -1) ||
      (b.peakRssBytes ?? -1) - (a.peakRssBytes ?? -1) ||
      a.owner.label.localeCompare(b.owner.label))
  const selectedChurn = snapshot.markers.filter(
    (marker): marker is LocalDiagnostics.ChurnMarker =>
      marker.type === "churn" && marker.at >= range.startAt && marker.at <= range.endAt,
  )

  return {
    bounds,
    range,
    series,
    contributors,
    churn: [...Map.groupBy(selectedChurn, (marker) => marker.ownerId).entries()].map(
      ([ownerId, markers]) => ({
        ownerId,
        launched: markers.reduce((total, marker) => total + marker.launched, 0),
        exited: markers.reduce((total, marker) => total + marker.exited, 0),
        resourceMeasurement: markers.every((marker) => marker.resourceMeasurement.state === "measured")
          ? ("measured" as const)
          : ("unmeasured" as const),
      }),
    ),
    markers: snapshot.markers.filter((marker) => marker.at >= range.startAt && marker.at <= range.endAt),
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

function adjacentStep(times: number[]) {
  const gaps = times.slice(1).map((time, index) => time - times[index]!).filter((gap) => gap > 0)
  return gaps.length > 0 ? Math.min(...gaps) : 1_000
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
