export type AttachTask = (signal: AbortSignal) => void | Promise<void>

type Entry = {
  key: string
  fn: AttachTask
  controller: AbortController
  resolve: () => void
  reject: (error: unknown) => void
  promise: Promise<void>
  running: boolean
  canceled: boolean
}

export function createAttachScheduler(input?: { concurrency?: number }) {
  const concurrency = Math.max(1, Math.floor(input?.concurrency ?? 2))
  const queue: Entry[] = []
  const byKey = new Map<string, Entry>()
  let active = 0

  const remove = (entry: Entry) => {
    const index = queue.indexOf(entry)
    if (index !== -1) queue.splice(index, 1)
    if (byKey.get(entry.key) === entry) byKey.delete(entry.key)
  }

  const pump = () => {
    while (active < concurrency) {
      const next = queue.find((entry) => !entry.running && !entry.canceled)
      if (!next) return
      next.running = true
      active += 1
      Promise.resolve(next.fn(next.controller.signal))
        .then(() => {
          if (!next.canceled) next.resolve()
        })
        .catch((error) => {
          if (!next.canceled) next.reject(error)
        })
        .finally(() => {
          active = Math.max(0, active - 1)
          remove(next)
          pump()
        })
    }
  }

  return {
    schedule(key: string, fn: AttachTask) {
      const existing = byKey.get(key)
      if (existing) {
        return {
          promise: existing.promise,
          cancel: () => {
            if (existing.canceled) return
            existing.canceled = true
            existing.controller.abort()
            if (!existing.running) {
              remove(existing)
              existing.reject(new Error("attach canceled"))
            }
          },
        }
      }

      let resolve = () => {}
      let reject = (_: unknown) => {}
      const entry: Entry = {
        key,
        fn,
        controller: new AbortController(),
        resolve: () => resolve(),
        reject: (error) => reject(error),
        promise: Promise.resolve(),
        running: false,
        canceled: false,
      }

      entry.promise = new Promise<void>((ok, no) => {
        resolve = ok
        reject = no
      })

      byKey.set(key, entry)
      queue.push(entry)
      pump()

      return {
        promise: entry.promise,
        cancel: () => {
          if (entry.canceled) return
          entry.canceled = true
          entry.controller.abort()
          if (!entry.running) {
            remove(entry)
            entry.reject(new Error("attach canceled"))
          }
        },
      }
    },
    inFlight() {
      return active
    },
    pending() {
      return queue.filter((entry) => !entry.running).length
    },
    clear() {
      const items = [...queue]
      for (const item of items) {
        item.canceled = true
        item.controller.abort()
        if (!item.running) {
          remove(item)
          item.reject(new Error("attach canceled"))
        }
      }
    },
  }
}

export const sharedAttachScheduler = createAttachScheduler({ concurrency: 2 })

// ============================================================================
// Flat scheduler API (callback-based, synchronous run)
// ============================================================================
// Simpler API used by terminal pane attach logic: scheduleAttach({ paneId, run })
// returns a cancel() function. MAX_CONCURRENT_ATTACHES limits concurrency.
// Deduplicates pending tasks by paneId so only the latest attach wins.

export const MAX_CONCURRENT_ATTACHES = 3

interface FlatTask {
  paneId: string
  run: (done: () => void) => void
  cancelled: boolean
  guard: { released: boolean }
}

let _inFlight = 0
const _queue: FlatTask[] = []

function _drainQueue(): void {
  while (_inFlight < MAX_CONCURRENT_ATTACHES && _queue.length > 0) {
    const task = _queue.shift()!
    if (task.cancelled) continue
    _startTask(task)
  }
}

function _startTask(task: FlatTask): void {
  _inFlight++
  const done = () => {
    if (task.guard.released) return
    task.guard.released = true
    _inFlight--
    _drainQueue()
  }
  task.run(done)
}

export function scheduleAttach(opts: {
  paneId: string
  run: (done: () => void) => void
}): () => void {
  // Cancel any pending (queued, not yet started) task for this paneId
  for (const pending of _queue) {
    if (pending.paneId === opts.paneId) {
      pending.cancelled = true
    }
  }

  const task: FlatTask = {
    paneId: opts.paneId,
    run: opts.run,
    cancelled: false,
    guard: { released: false },
  }

  if (_inFlight < MAX_CONCURRENT_ATTACHES) {
    _startTask(task)
    return () => {
      if (!task.guard.released) {
        task.guard.released = true
        _inFlight--
        _drainQueue()
      }
    }
  }

  _queue.push(task)
  return () => {
    task.cancelled = true
  }
}

/** Reset scheduler state — for use in tests only. */
export function _resetForTesting(): void {
  _inFlight = 0
  _queue.length = 0
}
