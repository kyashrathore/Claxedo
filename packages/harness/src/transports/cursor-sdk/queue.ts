export class CursorQueue<T> {
  private readonly values: T[] = []
  private waiter?: { resolve(value: IteratorResult<T>): void; reject(error: unknown): void }
  private state: { kind: "open" } | { kind: "ended" } | { kind: "failed"; error: unknown } = { kind: "open" }

  push(value: T) {
    if (this.state.kind !== "open") return
    if (this.waiter) { this.waiter.resolve({ value, done: false }); this.waiter = undefined }
    else this.values.push(value)
  }

  end() {
    this.state = { kind: "ended" }
    if (this.waiter) { this.waiter.resolve({ value: undefined, done: true }); this.waiter = undefined }
  }

  fail(error: unknown) {
    this.state = { kind: "failed", error }
    if (this.waiter) { this.waiter.reject(error); this.waiter = undefined }
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift()
    if (value !== undefined) return Promise.resolve({ value, done: false })
    if (this.state.kind === "failed") return Promise.reject(this.state.error)
    if (this.state.kind === "ended") return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject } })
  }
}
