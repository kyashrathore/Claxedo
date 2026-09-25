export class FrameCallError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = "FrameCallError"
  }
}

export type Settled = { readonly id: number; readonly ok: true; readonly value: unknown } | { readonly id: number; readonly ok: false; readonly reason: string }

export type Requests = {
  readonly open: () => { readonly id: number; readonly result: Promise<unknown> }
  readonly settle: (settled: Settled) => void
  readonly failAll: (reason: string) => void
}

export function createRequests(): Requests {
  const pending = new Map<number, { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }>()
  let next = 1
  return {
    open: () => {
      const id = next++
      const result = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }))
      return { id, result }
    },
    settle: (settled) => {
      const waiting = pending.get(settled.id)
      if (!waiting) return
      pending.delete(settled.id)
      if (settled.ok) waiting.resolve(settled.value)
      else waiting.reject(new FrameCallError(settled.reason))
    },
    failAll: (reason) => {
      for (const waiting of pending.values()) waiting.reject(new FrameCallError(reason))
      pending.clear()
    },
  }
}
