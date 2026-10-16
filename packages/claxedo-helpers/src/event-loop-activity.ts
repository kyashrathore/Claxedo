const active = new Map<string, number>()
const recent = new Set<string>()

/**
 * Names work that can hold the event loop, so a stall report can say what was
 * running. The name is also reported by the next take after it ends: a block
 * is seen only once the loop is free again, and the work may be done by then.
 */
export function beginEventLoopActivity(name: string): () => void {
  active.set(name, (active.get(name) ?? 0) + 1)
  recent.add(name)
  let ended = false
  return () => {
    if (ended) return
    ended = true
    recent.add(name)
    const remaining = (active.get(name) ?? 1) - 1
    if (remaining > 0) active.set(name, remaining)
    else active.delete(name)
  }
}

export async function duringEventLoopActivity<T>(name: string, run: () => Promise<T>): Promise<T> {
  const end = beginEventLoopActivity(name)
  try {
    return await run()
  } finally {
    end()
  }
}

/** The names running now, or begun or ended since the previous take. */
export function takeEventLoopActivity(): string[] {
  const names = new Set([...active.keys(), ...recent])
  recent.clear()
  return [...names].sort()
}
