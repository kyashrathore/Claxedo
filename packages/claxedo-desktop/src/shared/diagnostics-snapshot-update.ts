import { LocalDiagnostics } from "@claxedo/app/process-diagnostics-contract"

export function applyDiagnosticsSnapshotUpdate(
  current: LocalDiagnostics.RetainedSnapshot | undefined,
  input: unknown,
) {
  const update = LocalDiagnostics.SnapshotUpdate.safeParse(input)
  if (!update.success) return
  if (update.data.kind === "full") return update.data.snapshot
  if (
    !current ||
    current.generation !== update.data.delta.generation ||
    current.capturedAt !== update.data.delta.baseCapturedAt
  ) return
  const removedSamples = new Set(
    update.data.delta.sampleRemovals.map((sample) => sampleKey(sample)),
  )
  const samples = new Map(
    current.samples
      .filter((sample) => !removedSamples.has(sampleKey(sample)))
      .map((sample) => [sampleKey(sample), sample]),
  )
  update.data.delta.sampleUpserts.forEach((sample) => samples.set(sampleKey(sample), sample))
  const removedMarkers = new Set(update.data.delta.markerRemovals)
  const markers = new Map(
    current.markers
      .filter((marker) => !removedMarkers.has(marker.id))
      .map((marker) => [marker.id, marker]),
  )
  update.data.delta.markerUpserts.forEach((marker) => markers.set(marker.id, marker))
  const delta = update.data.delta
  return LocalDiagnostics.RetainedSnapshot.parse({
    version: 1,
    generation: delta.generation,
    capturedAt: delta.capturedAt,
    retainedFromAt: delta.retainedFromAt,
    targetWindowMs: delta.targetWindowMs,
    retention: delta.retention,
    owners: delta.owners,
    processes: delta.processes,
    samples: [...samples.values()].sort((a, b) => a.at - b.at || a.processId.localeCompare(b.processId)),
    sources: delta.sources,
    markers: [...markers.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)),
    interval: delta.interval,
  })
}

function sampleKey(sample: Pick<LocalDiagnostics.MetricPoint, "at" | "processId">) {
  return `${String(sample.at)}\0${sample.processId}`
}
