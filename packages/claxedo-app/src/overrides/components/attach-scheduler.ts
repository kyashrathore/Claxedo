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
