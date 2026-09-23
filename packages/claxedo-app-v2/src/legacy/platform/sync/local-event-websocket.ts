/** Preserve SSE frames and cursors without occupying a browser HTTP stream slot. */
export function openLocalEventWebSocket(url: URL, init: RequestInit = {}): Promise<Response> {
  const target = new URL(url)
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:"
  const cursor = new Headers(init.headers).get("Last-Event-ID")
  if (cursor) target.searchParams.set("lastEventId", cursor)
  return new Promise((resolve, reject) => {
    if (init.signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"))
      return
    }
    const socket = new WebSocket(target)
    socket.binaryType = "arraybuffer"
    let opened = false
    let ended = false
    let body!: ReadableStreamDefaultController<Uint8Array>
    const finish = (error?: Error) => {
      if (ended) return
      ended = true
      init.signal?.removeEventListener("abort", abort)
      if (!opened) reject(error ?? new Error("Event socket closed before opening"))
      else if (error) body.error(error)
      else body.close()
      socket.close()
    }
    const abort = () => finish(new DOMException("Aborted", "AbortError"))
    init.signal?.addEventListener("abort", abort, { once: true })
    socket.onopen = () => {
      if (ended) return
      opened = true
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { body = controller },
        cancel() {
          if (ended) return
          ended = true
          init.signal?.removeEventListener("abort", abort)
          socket.close()
        },
      })
      resolve(new Response(stream, { headers: { "content-type": "text/event-stream" } }))
    }
    socket.onmessage = (event) => {
      if (!opened || ended) return
      body.enqueue(typeof event.data === "string" ? new TextEncoder().encode(event.data) : new Uint8Array(event.data))
    }
    socket.onerror = () => finish(new Error("Local event WebSocket failed"))
    socket.onclose = (event) => finish(event.code === 1000 ? undefined : new Error(`Local event WebSocket closed (${event.code})`))
  })
}
