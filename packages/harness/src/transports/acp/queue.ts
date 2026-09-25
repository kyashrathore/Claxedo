export class AcpQueue<T> {
  private readonly values: T[] = []
  private waiter?: { resolve(value: IteratorResult<T>): void; reject(error: unknown): void }
  private done = false
  private error?: unknown

  push(value: T): void {
    if (this.done) return
    if (this.waiter) { this.waiter.resolve({ done: false, value }); this.waiter = undefined }
    else this.values.push(value)
  }

  end(): void {
    this.done = true
    if (this.waiter) { this.waiter.resolve({ done: true, value: undefined }); this.waiter = undefined }
  }

  fail(error: unknown): void {
    this.error = error
    if (this.waiter) { this.waiter.reject(error); this.waiter = undefined }
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift()
    if (value !== undefined) return Promise.resolve({ done: false, value })
    if (this.error) return Promise.reject(this.error)
    if (this.done) return Promise.resolve({ done: true, value: undefined })
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject } })
  }
}
