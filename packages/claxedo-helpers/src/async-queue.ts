export class AsyncPushQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<{ resolve(result: IteratorResult<T>): void; reject(error: unknown): void }> = []
  private readonly drainWaiters: Array<() => void> = []
  private state: { kind: "open" } | { kind: "ended" } | { kind: "failed"; error: unknown } = { kind: "open" }

  push(value: T): void {
    if (this.state.kind !== "open") return
    const waiter = this.waiters.shift()
    if (waiter) waiter.resolve({ done: false, value })
    else this.values.push(value)
  }

  end(): void {
    if (this.state.kind !== "open") return
    this.state = { kind: "ended" }
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined })
    this.releaseDrained()
  }

  fail(error: unknown): void {
    if (this.state.kind !== "open") return
    this.state = { kind: "failed", error }
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
    this.releaseDrained()
  }

  next(): Promise<IteratorResult<T>> {
    if (this.values.length) return Promise.resolve({ done: false, value: this.values.shift()! })
    if (this.state.kind === "failed") return Promise.reject(this.state.error)
    if (this.state.kind === "ended") return Promise.resolve({ done: true, value: undefined })
    this.releaseDrained()
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
  }

  /**
   * Resolves once the consumer has taken every value pushed before the call
   * and come back for another, or the queue has closed. A consumer that
   * finishes with each value before it asks for the next has then handled
   * all of them.
   */
  drained(): Promise<void> {
    if (this.state.kind !== "open" || (!this.values.length && this.waiters.length)) return Promise.resolve()
    return new Promise((resolve) => this.drainWaiters.push(resolve))
  }

  async take(): Promise<T> {
    const next = await this.next()
    if (next.done) throw new Error("Async push queue ended")
    return next.value
  }

  [Symbol.asyncIterator](): AsyncIterator<T> { return this }

  private releaseDrained(): void {
    for (const resolve of this.drainWaiters.splice(0)) resolve()
  }
}
