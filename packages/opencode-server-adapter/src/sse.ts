import { OpenCodeServerAdapterError } from "./errors"

export type ServerSentEvent = { data: string }

export async function* serverSentEvents(
  response: Response,
  options: { signal: AbortSignal; idleTimeoutMs: number; maxFrameBytes: number },
): AsyncIterable<ServerSentEvent> {
  if (!response.body) throw new OpenCodeServerAdapterError("invalid_response", "OpenCode event response has no body", { operation: "events.connect", status: response.status })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let bufferBytes = 0
  try {
    while (true) {
      const next = await readWithDeadline(reader, options)
      if (next.done) break
      bufferBytes += next.value.byteLength
      buffer += decoder.decode(next.value, { stream: true })
      if (bufferBytes > options.maxFrameBytes) throw frameTooLarge()
      let boundary = frameBoundary(buffer)
      while (boundary) {
        const raw = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary.length)
        bufferBytes = new TextEncoder().encode(buffer).byteLength
        const frame = parseFrame(raw)
        if (frame) yield frame
        boundary = frameBoundary(buffer)
      }
    }
    buffer += decoder.decode()
    if (bufferBytes > options.maxFrameBytes) throw frameTooLarge()
    const frame = parseFrame(buffer)
    if (frame) yield frame
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

async function readWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: { signal: AbortSignal; idleTimeoutMs: number },
) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new OpenCodeServerAdapterError("deadline_exceeded", "OpenCode event stream idle deadline exceeded", { operation: "events.read" })), options.idleTimeoutMs)
        onAbort = () => reject(options.signal.reason ?? new DOMException("Aborted", "AbortError"))
        options.signal.addEventListener("abort", onAbort, { once: true })
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
    if (onAbort) options.signal.removeEventListener("abort", onAbort)
  }
}

function parseFrame(value: string): ServerSentEvent | undefined {
  const data: string[] = []
  for (const line of value.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue
    const separator = line.indexOf(":")
    const field = separator === -1 ? line : line.slice(0, separator)
    const raw = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "")
    if (field === "data") data.push(raw)
  }
  return data.length ? { data: data.join("\n") } : undefined
}

function frameBoundary(value: string) {
  const match = /\r?\n\r?\n/.exec(value)
  return match ? { index: match.index, length: match[0].length } : undefined
}

function frameTooLarge() {
  return new OpenCodeServerAdapterError("frame_too_large", "OpenCode SSE frame exceeded the configured safety limit", { operation: "events.read" })
}
