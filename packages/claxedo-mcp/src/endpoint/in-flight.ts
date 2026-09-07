/**
 * How many requests one credential may hold open at once. A tool that waits
 * (`wait_for_attention`, `create_subagent` in `wait` mode) holds its POST for
 * the whole wait, so the count is released when the response body settles,
 * not when the handler returns it.
 */
export function createInFlightCounter(max: number) {
  const counts = new Map<string, number>()
  return {
    count: (key: string) => counts.get(key) ?? 0,
    acquire(key: string): (() => void) | undefined {
      const current = counts.get(key) ?? 0
      if (current >= max) return undefined
      counts.set(key, current + 1)
      let released = false
      return () => {
        if (released) return
        released = true
        const remaining = (counts.get(key) ?? 1) - 1
        if (remaining <= 0) counts.delete(key)
        else counts.set(key, remaining)
      }
    },
  }
}

/** `release` runs once the body has been fully read or cancelled; a bodiless response releases immediately. */
export function releaseWhenSettled(response: Response, release: () => void): Response {
  const source = response.body
  if (!source) {
    release()
    return response
  }
  const reader = source.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) {
        release()
        controller.close()
        return
      }
      controller.enqueue(value)
    },
    cancel(reason) {
      release()
      return reader.cancel(reason)
    },
  })
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}
