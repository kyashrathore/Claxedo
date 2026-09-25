export class EventQueue<T> {
  private values: T[] = []
  private waiter?: { resolve(value: IteratorResult<T>): void; reject(error: unknown): void }
  private ended = false
  private failure?: unknown

  push(value: T): void {
    if (this.ended) return
    if (this.waiter) { this.waiter.resolve({ value, done: false }); this.waiter = undefined }
    else this.values.push(value)
  }

  end(): void {
    this.ended = true
    if (this.waiter) { this.waiter.resolve({ value: undefined, done: true }); this.waiter = undefined }
  }

  fail(error: unknown): void {
    this.failure = error
    if (this.waiter) { this.waiter.reject(error); this.waiter = undefined }
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift()
    if (value !== undefined) return Promise.resolve({ value, done: false })
    if (this.failure) return Promise.reject(this.failure)
    if (this.ended) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject } })
  }
}
