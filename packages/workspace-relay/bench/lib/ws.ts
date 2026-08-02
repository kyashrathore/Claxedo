// WebSocket probe: opens one connection, times the handshake, echoes N frames
// measuring per-message round-trip, and captures the relay.trace frame the
// relay emits when x-claxedo-relay-ws-trace: 1 is requested. Uses the global
// WebSocket (Bun/undici), which accepts custom headers and subprotocols so the
// Runtime Access Token can ride either as a Bearer header (HTTP-style) or the
// claxedo-rat.<token> subprotocol (browser-style, exactly what real clients
// use for the upgrade).

export type RelayTraceFrame = {
  type: "relay.trace"
  wsUpstreamOpenMs?: number
  queuedFrames?: number
  maxQueuedDelayMs?: number
}

export type WsProbeResult = {
  connected: boolean
  connectMs: number
  rtts: number[]
  sent: number
  delivered: number
  trace?: RelayTraceFrame
  // Close/error code observed when setup or delivery failed. Numeric WS close
  // codes; "timeout" when the open never completed within the deadline.
  failureCode?: string
  // The close REASON that accompanied `failureCode`. The code alone says a
  // connection died; the reason says why, and the relay always supplies one
  // (e.g. "Upstream WebSocket queue limit exceeded"). Dropping it is what made
  // the 2026-07-17 dialin-100k failure unreadable for two weeks — the report
  // said `1011x50` while the relay was naming the exact guard that fired.
  failureReason?: string
}

export type WsProbeOptions = {
  url: string
  messages: number
  // Bytes per echo frame (payload is padded to this size). Default ~64B.
  messageBytes?: number
  // Subprotocols to offer, e.g. [`claxedo-rat.${rat}`].
  protocols?: string[]
  headers?: Record<string, string>
  requestTrace?: boolean
  openTimeoutMs?: number
  messageTimeoutMs?: number
}

function isTraceFrame(value: unknown): value is RelayTraceFrame {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "relay.trace"
  )
}

export async function probeWebSocket(options: WsProbeOptions): Promise<WsProbeResult> {
  const openTimeoutMs = options.openTimeoutMs ?? 30_000
  const messageTimeoutMs = options.messageTimeoutMs ?? 30_000
  const messageBytes = Math.max(8, options.messageBytes ?? 64)
  const result: WsProbeResult = { connected: false, connectMs: Number.NaN, rtts: [], sent: 0, delivered: 0 }

  const startedAt = performance.now()
  // Bun's WebSocket accepts an options object as the SECOND argument carrying
  // both `protocols` and `headers` (custom headers like Origin and the trace
  // opt-in ride here). The plain DOM form `new WebSocket(url, protocols)` can't
  // send headers, so we always use the object form when headers are present.
  const ctor = WebSocket as unknown as {
    new (url: string, options?: string[] | { protocols?: string[]; headers?: Record<string, string> }): WebSocket
  }
  let socket: WebSocket
  try {
    if (options.headers) {
      socket = new ctor(options.url, {
        ...(options.protocols ? { protocols: options.protocols } : {}),
        headers: options.headers,
      })
    } else if (options.protocols) {
      socket = new ctor(options.url, options.protocols)
    } else {
      socket = new ctor(options.url)
    }
  } catch (err) {
    result.failureCode = err instanceof Error ? err.message : "construct_failed"
    return result
  }
  socket.binaryType = "arraybuffer"

  return await new Promise<WsProbeResult>((resolve) => {
    const pendingSends = new Map<string, number>()
    let settled = false
    let openTimer: ReturnType<typeof setTimeout> | undefined
    let messageTimer: ReturnType<typeof setTimeout> | undefined

    const finish = () => {
      if (settled) return
      settled = true
      if (openTimer) clearTimeout(openTimer)
      if (messageTimer) clearTimeout(messageTimer)
      try {
        socket.close()
      } catch {
        // best effort
      }
      resolve(result)
    }

    const payload = (index: number) => {
      const marker = `bench:${index}:`
      return marker + "x".repeat(Math.max(0, messageBytes - marker.length))
    }

    const sendNext = () => {
      if (result.sent >= options.messages) return
      const index = result.sent
      const body = payload(index)
      pendingSends.set(body, performance.now())
      try {
        socket.send(body)
      } catch {
        result.failureCode = result.failureCode ?? "send_failed"
        finish()
        return
      }
      result.sent += 1
    }

    openTimer = setTimeout(() => {
      if (!result.connected) {
        result.failureCode = "timeout"
        finish()
      }
    }, openTimeoutMs)

    socket.addEventListener("open", () => {
      result.connected = true
      result.connectMs = performance.now() - startedAt
      if (options.messages === 0) {
        finish()
        return
      }
      messageTimer = setTimeout(() => {
        result.failureCode = result.failureCode ?? "message_timeout"
        finish()
      }, messageTimeoutMs)
      // Pipeline all frames; echo replies unwind them.
      for (let i = 0; i < options.messages; i++) sendNext()
    })

    socket.addEventListener("message", (event: MessageEvent) => {
      const now = performance.now()
      let text: string | undefined
      if (typeof event.data === "string") text = event.data
      else if (event.data instanceof ArrayBuffer) text = new TextDecoder().decode(event.data)
      if (text === undefined) return
      if (text.startsWith("{")) {
        try {
          const parsed = JSON.parse(text) as unknown
          if (isTraceFrame(parsed)) {
            result.trace = parsed
            return
          }
        } catch {
          // fall through: not JSON, treat as an echo frame
        }
      }
      const sentAt = pendingSends.get(text)
      if (sentAt !== undefined) {
        pendingSends.delete(text)
        result.rtts.push(now - sentAt)
        result.delivered += 1
        if (result.delivered >= options.messages) finish()
      }
    })

    socket.addEventListener("error", () => {
      if (!result.connected) result.failureCode = result.failureCode ?? "error"
    })

    socket.addEventListener("close", (event: CloseEvent) => {
      if (result.delivered < options.messages) {
        result.failureCode = result.failureCode ?? String(event.code || "closed")
        const reason = (event as { reason?: string }).reason
        if (reason) result.failureReason = result.failureReason ?? reason
      }
      finish()
    })
  })
}
