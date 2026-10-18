export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export type ChunkTap = (chunk: Uint8Array, at: number) => void

/**
 * The body's chunks, each released `ms` after it arrived and in arrival order:
 * one direction of a link with a fixed latency. Chunks are read as they come so
 * the delay measures the link, not the reader.
 */
export function delayedBody(body: ReadableStream<Uint8Array> | null, ms: number, tap?: ChunkTap): ReadableStream<Uint8Array> | null {
  if (!body) return body
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let chain = Promise.resolve()
      try {
        for (let next = await reader.read(); !next.done; next = await reader.read()) {
          const at = performance.now()
          const chunk = next.value
          tap?.(chunk, at)
          chain = chain.then(() => sleep(Math.max(0, ms - (performance.now() - at)))).then(() => controller.enqueue(chunk))
        }
        await chain
        controller.close()
      } catch (error) {
        await chain.catch(() => undefined)
        controller.error(error)
      }
    },
    cancel: (reason) => reader.cancel(reason),
  })
}

/** The response after the link: its headers `ms` later, and each body chunk `ms` after the chunk arrived. */
export async function delayedResponse(response: Response, ms: number, tap?: ChunkTap): Promise<Response> {
  const body = delayedBody(response.body, ms, tap)
  await sleep(ms)
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}

export type Summary = { n: number; mean: number; p50: number; p95: number; min: number; max: number; sd: number }

export function summarize(values: readonly number[]): Summary | undefined {
  if (!values.length) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1) + 0.5))]
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length
  const sd = Math.sqrt(sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sorted.length)
  return { n: sorted.length, mean, p50: at(0.5), p95: at(0.95), min: sorted[0], max: sorted[sorted.length - 1], sd }
}

export function intervals(times: readonly number[]): number[] {
  return times.slice(1).map((time, index) => time - times[index])
}

export const ms = (value: number | undefined) => value === undefined ? "-" : value.toFixed(value >= 100 ? 0 : 1)
