export interface RetryOptions {
  attempts?: number
  delay?: number
  factor?: number
  maxDelay?: number
  retryIf?: (error: unknown) => boolean
}

const TRANSIENT_MESSAGES = [
  "load failed",
  "network connection was lost",
  "network request failed",
  "failed to fetch",
  "econnreset",
  "econnrefused",
  "etimedout",
  "socket hang up",
]

function isTransientError(error: unknown): boolean {
  if (!error) return false
  // oxlint-disable-next-line no-base-to-string -- error is unknown, intentional coercion for message matching
  const message = String(error instanceof Error ? error.message : error).toLowerCase()
  return TRANSIENT_MESSAGES.some((m) => message.includes(m))
}

export async function retry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { attempts = 3, delay = 500, factor = 2, maxDelay = 10000, retryIf = isTransientError } = options

  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (attempt === attempts - 1 || !retryIf(error)) throw error
      const wait = Math.min(delay * Math.pow(factor, attempt), maxDelay)
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }
  throw lastError
}

/**
 * Share one pending or successful asynchronous load, while allowing a later
 * call to retry after the current load rejects.
 *
 * The rejection handler observes the failure and only clears the promise it
 * belongs to. That identity check keeps an older failure from erasing a newer
 * load if the loader is ever extended with an explicit refresh path.
 */
export function memoizeSuccessfulLoad<T>(load: () => Promise<T>) {
  let pending: Promise<T> | undefined

  return () => {
    if (pending) return pending

    const current = load()
    pending = current
    void current.then(undefined, () => {
      if (pending === current) pending = undefined
    })
    return current
  }
}
