export type RelayHttpOptions = Readonly<{
  requestTimeoutMs?: number
  maxResponseBytes?: number
}>

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024

export async function fetchRelayResponse(
  fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  input: string | URL | Request,
  init: RequestInit,
  options: RelayHttpOptions,
) {
  return await withDeadline(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, init.signal, async (signal) => {
    const response = await fetcher(input, { ...init, signal })
    return { response, body: await readBounded(response, options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, signal) }
  })
}

export function parseRelayJson(bytes: Uint8Array, label: string) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown
  } catch {
    throw new Error(`${label} response is invalid`)
  }
}

export function relayResponseText(bytes: Uint8Array) {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes)
}

async function readBounded(response: Response, maxBytes: number, signal: AbortSignal) {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Document relay response is too large")
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const cancel = () => void reader.cancel(signal.reason).catch(() => undefined)
  signal.addEventListener("abort", cancel, { once: true })
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error("Document relay response is too large")
      }
      chunks.push(chunk.value)
    }
  } finally {
    signal.removeEventListener("abort", cancel)
  }
  const result = new Uint8Array(total)
  let offset = 0
  chunks.forEach((chunk) => {
    result.set(chunk, offset)
    offset += chunk.byteLength
  })
  return result
}

async function withDeadline<T>(
  timeoutMs: number,
  parentSignal: AbortSignal | null | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
) {
  const controller = new AbortController()
  let rejectDeadline: (error: Error) => void = () => undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject
  })
  const abort = (error: Error) => {
    if (controller.signal.aborted) return
    controller.abort(error)
    rejectDeadline(error)
  }
  const onParentAbort = () => abort(parentSignal?.reason instanceof Error
    ? parentSignal.reason
    : new Error("Document relay request was cancelled"))
  if (parentSignal?.aborted) onParentAbort()
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true })
  const timeout = setTimeout(() => abort(new Error("Document relay request timed out")), Math.max(1, timeoutMs))
  try {
    return await Promise.race([operation(controller.signal), deadline])
  } finally {
    clearTimeout(timeout)
    parentSignal?.removeEventListener("abort", onParentAbort)
  }
}
