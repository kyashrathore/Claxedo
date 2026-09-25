import type { Clock } from "../contract"

type Pending<T, Result> = { metadata: T; resolve(value: Result): void; reject(error: unknown): void; timer?: unknown }

export class PendingRpcRequests<Id extends string | number, Metadata = undefined, Result = unknown> {
  private readonly pending = new Map<Id, Pending<Metadata, Result>>()
  private failure?: Error

  constructor(private readonly clock?: Clock) {}

  get(id: Id): Metadata | undefined { return this.pending.get(id)?.metadata }

  request(id: Id, metadata: Metadata, timeoutMs: number | undefined, timeoutError: () => Error, send: () => void): Promise<Result> {
    if (this.failure) return Promise.reject(this.failure)
    if (timeoutMs !== undefined && !this.clock) throw new Error("A timed RPC request requires a clock")
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === undefined ? undefined : this.clock!.setTimeout(() => {
        this.pending.delete(id)
        reject(timeoutError())
      }, timeoutMs)
      this.pending.set(id, { metadata, resolve, reject, timer })
      try { send() }
      catch (error) { this.reject(id, error) }
    })
  }

  resolve(id: Id, value: Result): boolean { return this.settle(id, (pending) => pending.resolve(value)) }

  reject(id: Id, error: unknown): boolean { return this.settle(id, (pending) => pending.reject(error)) }

  private settle(id: Id, finish: (pending: Pending<Metadata, Result>) => void): boolean {
    const pending = this.pending.get(id)
    if (!pending) return false
    this.pending.delete(id)
    if (pending.timer !== undefined) this.clock!.clearTimeout(pending.timer)
    finish(pending)
    return true
  }

  fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    for (const id of this.pending.keys()) this.reject(id, error)
  }
}
