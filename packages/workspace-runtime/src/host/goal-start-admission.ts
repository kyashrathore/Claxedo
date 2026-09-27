/** Serializes Goal starts per session without a failed start blocking its successor. */
export function createGoalStartAdmission() {
  const pending = new Map<string, Promise<void>>()
  return {
    async run<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
      const previous = pending.get(sessionId) ?? Promise.resolve()
      const run = previous.catch(() => {}).then(operation)
      const settled = run.then(() => {}, () => {})
      pending.set(sessionId, settled)
      try {
        return await run
      } finally {
        if (pending.get(sessionId) === settled) pending.delete(sessionId)
      }
    },
    clear() { pending.clear() },
  }
}
