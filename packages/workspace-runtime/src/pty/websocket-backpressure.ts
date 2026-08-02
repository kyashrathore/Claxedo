export type WebSocketBackpressureSocket = {
  readyState: number
  bufferedAmount?: number
  send(data: string | Uint8Array | ArrayBuffer): void
  close(code?: number, reason?: string): void
}

export function sendWebSocketWithBackpressure(
  ws: WebSocketBackpressureSocket,
  data: string | Uint8Array | ArrayBuffer,
  input: { maxBufferedBytes: number },
) {
  if (ws.readyState !== 1) return false
  const bufferedAmount = Number.isFinite(ws.bufferedAmount) ? ws.bufferedAmount ?? 0 : 0
  if (bufferedAmount > input.maxBufferedBytes) {
    ws.close(1013, "WebSocket backpressure limit exceeded")
    return false
  }
  try {
    ws.send(data)
    return true
  } catch {
    ws.close()
    return false
  }
}
