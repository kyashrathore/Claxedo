import { queryClient } from "@/shared/query/query-client"

type QueueInput = {
  paused: () => boolean
  bootstrap: () => Promise<void>
  bootstrapInstance: (directory: string) => Promise<void> | void
  key?: (directory: string) => string
  owner?: string
}

export const refreshQueueQueryRoot = ["shell", "global-sync-refresh-queue"] as const

type QueuedDirectory = {
  id: string
  directory: string
}

let queueOwnerSeq = 0

export function createRefreshQueue(input: QueueInput) {
  const owner = input.owner ?? `queue-${++queueOwnerSeq}`
  const queryKey = [...refreshQueueQueryRoot, owner] as const
  let root = false
  let running = false
  let timer: ReturnType<typeof setTimeout> | undefined
  // Directory the user is currently looking at. When set and queued, it is
  // promoted to the front of any drain cycle so the foreground workspace
  // hydrates before any background ones — keeps the visible surface
  // interactive while the rest fill in.
  let focusedDir: string | undefined

  const key = input.key ?? ((directory: string) => directory)

  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
  const queued = () => queryClient.getQueryData<QueuedDirectory[]>(queryKey) ?? []
  const setQueued = (next: QueuedDirectory[]) => {
    queryClient.setQueryData(queryKey, next)
  }

  const take = (count: number) => {
    const current = queued()
    if (current.length === 0) return [] as string[]
    const items: string[] = []
    const taken = new Set<string>()
    // Focused-first: if the user is looking at a queued directory, drain it
    // before any other. The browser's HTTP slots are limited, so spending
    // them on the foreground workspace first keeps the user-visible
    // surface interactive while background workspaces hydrate behind it.
    if (focusedDir) {
      const focusedId = key(focusedDir)
      const focused = current.find((item) => item.id === focusedId)
      if (focused) {
        taken.add(focused.id)
        items.push(focused.directory)
      }
    }
    for (const item of current) {
      if (taken.has(item.id)) continue
      items.push(item.directory)
      taken.add(item.id)
      if (items.length >= count) break
    }
    setQueued(current.filter((item) => !taken.has(item.id)))
    return items
  }

  const schedule = () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      void drain()
    }, 0)
  }

  const push = (directory: string) => {
    if (!directory) return
    const id = key(directory)
    const existing = queued()
    const index = existing.findIndex((item) => item.id === id)
    if (index === -1) setQueued([...existing, { id, directory }])
    else setQueued(existing.map((item, itemIndex) => itemIndex === index ? { id, directory } : item))
    if (input.paused()) return
    schedule()
  }

  const refresh = () => {
    root = true
    if (input.paused()) return
    schedule()
  }

  async function drain() {
    if (running) return
    running = true
    try {
      while (true) {
        if (input.paused()) return
        if (root) {
          root = false
          await input.bootstrap()
          await tick()
          continue
        }
        const dirs = take(2)
        if (dirs.length === 0) return
        await Promise.all(dirs.map((dir) => input.bootstrapInstance(dir)))
        await tick()
      }
    } finally {
      running = false
      // oxlint-disable-next-line no-unsafe-finally -- intentional: early return skips schedule() when paused
      if (input.paused()) return
      if (root || queued().length > 0) schedule()
    }
  }

  return {
    push,
    refresh,
    // Caller declares which directory the user is currently focused on.
    // Call with undefined to unset (e.g. when the user navigates away from
    // any directory). Affects only drain ordering — does not push anything
    // into the queue on its own.
    setFocused(directory: string | undefined) {
      focusedDir = directory
    },
    clear(directory: string) {
      const id = key(directory)
      setQueued(queued().filter((item) => item.id !== id))
    },
    dispose() {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      queryClient.removeQueries({ queryKey, exact: true })
    },
  }
}
