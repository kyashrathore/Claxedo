/** Serializes automatic and explicit title writes so an explicit rename wins. */
export function createTitleMutationCoordinator() {
  const tails = new Map<string, Promise<void>>()

  return async function withTitleMutation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = tails.get(sessionId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => current)
    tails.set(sessionId, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (tails.get(sessionId) === tail) tails.delete(sessionId)
    }
  }
}
