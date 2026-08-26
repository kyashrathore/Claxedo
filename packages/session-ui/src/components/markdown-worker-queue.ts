type QueueRequest = { key: string; priority?: number }
type Highlight<T> = { type: "highlight"; key: string; request?: T; order: number; bytes: number }
type Dispose = { type: "dispose"; key: string; order: number }

/** Serial worker queue that coalesces revisions by key and runs visible work first. */
export function createLatestWorkerQueue<T extends QueueRequest>(input: {
  run: (request: T) => Promise<void>
  supersede: (request: T) => void
  dispose: (key: string) => void
  bytes?: (request: T) => number
  maxPendingBytes?: number
}) {
  const jobs: Array<Highlight<T> | Dispose> = []
  const slots = new Map<string, Highlight<T>>()
  let running: Promise<void> | undefined
  let order = 0
  let pendingBytes = 0

  const removeRequest = (slot: Highlight<T>, supersede: boolean) => {
    const request = slot.request
    if (!request) return
    slot.request = undefined
    pendingBytes -= slot.bytes
    slot.bytes = 0
    if (supersede) input.supersede(request)
  }

  const trim = () => {
    const limit = input.maxPendingBytes ?? Number.POSITIVE_INFINITY
    while (pendingBytes > limit) {
      let victim: Highlight<T> | undefined
      for (const slot of slots.values()) {
        if (!slot.request) continue
        if (
          !victim ||
          (slot.request.priority ?? 0) < (victim.request?.priority ?? 0) ||
          ((slot.request.priority ?? 0) === (victim.request?.priority ?? 0) && slot.order < victim.order)
        )
          victim = slot
      }
      if (!victim) return
      removeRequest(victim, true)
      slots.delete(victim.key)
    }
  }

  const take = () => {
    let selected: Highlight<T> | Dispose | undefined
    const seen = new Set<string>()
    for (const job of jobs) {
      if (job.type === "highlight" && !job.request) continue
      if (seen.has(job.key)) continue
      seen.add(job.key)
      if (!selected) {
        selected = job
        continue
      }
      const priority = job.type === "dispose" ? Number.POSITIVE_INFINITY : (job.request?.priority ?? 0)
      const selectedPriority =
        selected.type === "dispose" ? Number.POSITIVE_INFINITY : (selected.request?.priority ?? 0)
      if (priority > selectedPriority || (priority === selectedPriority && job.order < selected.order)) selected = job
    }
    if (!selected) return
    jobs.splice(jobs.indexOf(selected), 1)
    return selected
  }

  const schedule = () => {
    if (running) return
    running = Promise.resolve()
      .then(async () => {
        while (jobs.length > 0) {
          const job = take()
          if (!job) {
            jobs.length = 0
            break
          }
          if (job.type === "dispose") {
            input.dispose(job.key)
            continue
          }
          if (slots.get(job.key) === job) slots.delete(job.key)
          const request = job.request
          removeRequest(job, false)
          if (request) await input.run(request)
        }
      })
      .finally(() => {
        running = undefined
        if (jobs.length > 0) schedule()
      })
  }

  return {
    highlight(request: T) {
      const slot = slots.get(request.key)
      if (slot) {
        removeRequest(slot, true)
        slot.request = request
        slot.bytes = Math.max(0, input.bytes?.(request) ?? 0)
        pendingBytes += slot.bytes
        trim()
        return
      }
      const next: Highlight<T> = {
        type: "highlight",
        key: request.key,
        request,
        order: order++,
        bytes: Math.max(0, input.bytes?.(request) ?? 0),
      }
      slots.set(request.key, next)
      jobs.push(next)
      pendingBytes += next.bytes
      trim()
      schedule()
    },
    dispose(key: string) {
      const slot = slots.get(key)
      const afterHighlight = !!slot
      if (slot) {
        removeRequest(slot, true)
        slots.delete(key)
      }
      // Repeated disposal with no intervening highlight has the same effect.
      if (afterHighlight || !jobs.some((job) => job.type === "dispose" && job.key === key))
        jobs.push({ type: "dispose", key, order: order++ })
      schedule()
    },
    pending: () => slots.size,
    pendingBytes: () => pendingBytes,
    async idle() {
      while (running) await running
    },
  }
}
