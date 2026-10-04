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
  ) {
    const fresh = timings.filter((timing, index) =>
      !progress.phases.includes(timing.phase) && timings.findIndex((other) => other.phase === timing.phase) === index)
    if (!fresh.length) return
    const next = {
      ...progress,
      markedAt: extra.markedAt ?? progress.markedAt,
      phases: [...progress.phases, ...fresh.map((timing) => timing.phase)],
    }
    if (!await options.leaseStore.update(lease.workspaceId, lease.epoch, { start: next })) return
    for (const timing of fresh) emit(lease, next, timing, extra)
  }

  async function started(workspaceId: string, epoch: number) {
    const lease = await options.leaseStore.get(workspaceId)
    return lease?.epoch === epoch && lease.start ? { lease, progress: lease.start } : undefined
  }

  return {
    /**
     * The phases one provision call observes, timed as they end and written
     * once when the call is done, so observing them adds no lease write to
     * the path a start waits on. A serving lease is not starting.
     */
    observe(lease: SandboxLease, input: { bootMode: SandboxBootMode; enteredAt: number; labels: Record<string, string> }) {
      if (lease.status === "ready") return undefined
      const progress = lease.start ?? { startedAt: input.enteredAt, bootMode: input.bootMode, markedAt: input.enteredAt, phases: [] }
      const ended: Timing[] = []
      let markedAt = progress.markedAt
      const end = (phase: SandboxStartPhase) => {
        if (progress.phases.includes(phase) || ended.some((timing) => timing.phase === phase)) return
        const at = options.now()
        ended.push({ phase, durationMs: Math.max(0, at - markedAt) })
        markedAt = at
      }
      if (!lease.start) end("lease_decision")
      return {
        end,
        flush: async () => {
          await append(lease, progress, ended, { labels: input.labels, markedAt }).catch(() => undefined)
        },
      }
    },
    async report(workspaceId: string, input: SandboxStartPhasesReport) {
      const start = await started(workspaceId, input.epoch)
      if (!start) return
      await append(start.lease, start.progress, input.phases, {
        labels: start.lease.labels ?? {},
        ...(input.repoSizeBytes === undefined ? {} : { repoSizeBytes: input.repoSizeBytes }),
      })
    },
    async markAfter(workspaceId: string, input: { epoch: number; phase: SandboxStartPhase; notBefore: number }) {
      const start = await started(workspaceId, input.epoch)
      if (!start || input.notBefore < start.progress.startedAt) return
      const at = options.now()
      await append(start.lease, start.progress, [{ phase: input.phase, durationMs: Math.max(0, at - start.progress.markedAt) }], {
        labels: start.lease.labels ?? {},
        markedAt: at,
      })
    },
  }
}
