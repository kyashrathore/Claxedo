import type { UnifiedUsageResponse } from "@claxedo/usage-contract"

type Quota = UnifiedUsageResponse["quota"]

const QUOTA_READ_DEADLINE_MS = 8_000

function withTimeout<T>(promise: Promise<T>, ms: number, timeoutError: () => Error) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError()), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * What one usage route answers for the quota view, held per reader key.
 *
 * The last good plans stand when a read fails: the figures a user is looking
 * at did not stop being true because a refresh could not reach a vendor, and
 * blanking every card is how Refresh came to lose the whole view. The key is
 * whoever the plans belong to, so one person's plans are never drawn for
 * another.
 */
export function quotaAnswers() {
  const held = new Map<string, Quota>()
  const consumed = new Set<number>()
  const remember = (key: string, value: Quota) => {
    held.delete(key)
    held.set(key, value)
    while (held.size > 8) held.delete(held.keys().next().value!)
  }
  return {
    /** True for a nonce not seen before, false for none or a repeat, undefined for one that is not a nonce. */
    consumeRefreshNonce(raw: string | undefined) {
      if (raw === undefined) return false
      const nonce = Number(raw)
      if (!Number.isSafeInteger(nonce) || nonce <= 0) return undefined
      if (consumed.has(nonce)) return false
      consumed.add(nonce)
      while (consumed.size > 64) consumed.delete(consumed.values().next().value!)
      return true
    },
    async read(key: string, read: () => Promise<Quota>): Promise<Quota> {
      try {
        const answer = await withTimeout(read(), QUOTA_READ_DEADLINE_MS, () => new Error("quota read timed out"))
        // The plans are what a later failed read stands in with; the spacing
        // of the refresh that produced them expires on its own and would date
        // a held answer as if it had just been throttled.
        if (answer.snapshot) remember(key, { status: answer.status, snapshot: answer.snapshot })
        return answer
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const last = held.get(key)
        return last ? { ...last, error: message } : { status: "unavailable", error: message }
      }
    },
  }
}
