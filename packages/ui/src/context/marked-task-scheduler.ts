export type LatestTaskOptions = {
  key: string
  priority?: number
  bytes?: number
}

type Task<T> = Required<Pick<LatestTaskOptions, "key">> & {
  priority: number
  bytes: number
  order: number
  run: () => Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

export class LatestTaskSupersededError extends Error {
  constructor() {
    super("Task was superseded by a newer revision")
    this.name = "LatestTaskSupersededError"
  }
}

/** A concurrency- and byte-bounded, latest-per-key scheduler with visible-first priority. */
export function createLatestTaskScheduler(input: { maxConcurrent: number; maxPendingBytes: number }) {
  let active = 0
  let order = 0
  let pendingBytes = 0
  const pending = new Map<string, Task<unknown>>()
  const activeKeys = new Set<string>()

  const remove = (task: Task<unknown>, error?: unknown) => {
    if (pending.get(task.key) !== task) return
    pending.delete(task.key)
    pendingBytes -= task.bytes
    if (error) task.reject(error)
  }

  const next = () => {
    let selected: Task<unknown> | undefined
    for (const task of pending.values()) {
      if (activeKeys.has(task.key)) continue
      if (!selected || task.priority > selected.priority || (task.priority === selected.priority && task.order < selected.order))
        selected = task
    }
    return selected
  }

  const drain = () => {
    while (active < input.maxConcurrent) {
      const task = next()
      if (!task) return
      remove(task)
      active += 1
      activeKeys.add(task.key)
      Promise.resolve()
        .then(task.run)
        .then(task.resolve, task.reject)
        .finally(() => {
          active -= 1
          activeKeys.delete(task.key)
          drain()
        })
    }
  }

  const trim = () => {
    while (pendingBytes > input.maxPendingBytes && pending.size > 0) {
      let victim: Task<unknown> | undefined
      for (const task of pending.values()) {
        if (!victim || task.priority < victim.priority || (task.priority === victim.priority && task.order < victim.order))
          victim = task
      }
      if (!victim) return
      remove(victim, new LatestTaskSupersededError())
    }
  }

  return {
    schedule<T>(options: LatestTaskOptions, run: () => Promise<T>) {
      return new Promise<T>((resolve, reject) => {
        const previous = pending.get(options.key)
        if (previous) remove(previous, new LatestTaskSupersededError())
        const task: Task<T> = {
          key: options.key,
          priority: options.priority ?? 0,
          bytes: Math.max(0, options.bytes ?? 0),
          order: order++,
          run,
          resolve,
          reject,
        }
        pending.set(task.key, task as Task<unknown>)
        pendingBytes += task.bytes
        trim()
        drain()
      })
    },
    inspect() {
      return { active, pending: pending.size, pendingBytes }
    },
  }
}
