import type { SandboxPhaseTiming, SandboxStartPhase } from "@claxedo/sandbox-contract"
import type {
  SandboxBootMode,
  SandboxLease,
  SandboxLeaseStore,
  SandboxStartPhaseEvent,
  SandboxStartPhasesReport,
  SandboxStartProgress,
} from "./contract"

type Timing = SandboxPhaseTiming<SandboxStartPhase>

/**
 * The one writer of a lease epoch's start: each phase is persisted into the
 * lease before it is emitted, at most once per epoch, so a phase observed by
 * two pollers or reported twice by a runtime reaches the sink once.
 */
export function createSandboxStartRecorder(options: {
  leaseStore: SandboxLeaseStore
  driver: string
  now: () => number
  onStartPhase?: (event: SandboxStartPhaseEvent) => void
}) {
  function emit(lease: SandboxLease, progress: SandboxStartProgress, timing: Timing, extra: { labels: Record<string, string>; repoSizeBytes?: number }) {
    try {
      options.onStartPhase?.({
        ...timing,
        workspaceId: lease.workspaceId,
        epoch: lease.epoch,
        driver: options.driver,
        homeRegion: lease.homeRegion,
        bootMode: progress.bootMode,
        labels: extra.labels,
        ...(extra.repoSizeBytes === undefined ? {} : { repoSizeBytes: extra.repoSizeBytes }),
      })
    } catch {
      // Start telemetry is evidence about the start, never part of it.
    }
  }

  async function append(
    lease: SandboxLease,
    progress: SandboxStartProgress,
    timings: readonly Timing[],
    extra: { labels: Record<string, string>; markedAt?: number; repoSizeBytes?: number },
  ): Promise<SandboxStartProgress> {
    const fresh = timings.filter((timing, index) =>
      !progress.phases.includes(timing.phase) && timings.findIndex((other) => other.phase === timing.phase) === index)
    if (!fresh.length) return progress
    const next = {
      ...progress,
      markedAt: extra.markedAt ?? progress.markedAt,
      phases: [...progress.phases, ...fresh.map((timing) => timing.phase)],
    }
    if (!await options.leaseStore.update(lease.workspaceId, lease.epoch, { start: next })) return progress
    for (const timing of fresh) emit(lease, next, timing, extra)
    return next
  }

  async function mark(lease: SandboxLease, progress: SandboxStartProgress, phase: SandboxStartPhase, labels: Record<string, string>) {
    const at = options.now()
    return await append(lease, progress, [{ phase, durationMs: Math.max(0, at - progress.markedAt) }], { labels, markedAt: at })
  }

  async function open(workspaceId: string, epoch: number) {
    const lease = await options.leaseStore.get(workspaceId)
    return lease?.epoch === epoch && lease.start ? { lease, progress: lease.start } : undefined
  }

  return {
    async begin(lease: SandboxLease, bootMode: SandboxBootMode, startedAt: number, labels: Record<string, string>) {
      return await mark(lease, { startedAt, bootMode, markedAt: startedAt, phases: [] }, "lease_decision", labels)
    },
    mark,
    async report(workspaceId: string, input: SandboxStartPhasesReport) {
      const start = await open(workspaceId, input.epoch)
      if (!start) return
      await append(start.lease, start.progress, input.phases, {
        labels: start.lease.labels ?? {},
        ...(input.repoSizeBytes === undefined ? {} : { repoSizeBytes: input.repoSizeBytes }),
      })
    },
    async markAfter(workspaceId: string, input: { epoch: number; phase: SandboxStartPhase; notBefore: number }) {
      const start = await open(workspaceId, input.epoch)
      if (!start || input.notBefore < start.progress.startedAt) return
      await mark(start.lease, start.progress, input.phase, start.lease.labels ?? {})
    },
  }
}
