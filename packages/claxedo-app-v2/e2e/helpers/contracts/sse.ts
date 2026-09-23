import { encodeSseData } from "../../../../agent-sdk-runtime/src/sse"

const decoder = new TextDecoder()

/** Canonical SSE byte encoder shared by both real streams. */
export function sseFrame(payload: unknown, id?: string) {
  return decoder.decode(encodeSseData(payload, id))
}

/** The bootstrap frame both `cp/events` and `wr/events` open with: a heartbeat carrying the resume cursor. */
export function streamHeartbeat(lastEventId?: number) {
  return sseFrame({ type: "heartbeat" }, String(lastEventId ?? 0))
}
