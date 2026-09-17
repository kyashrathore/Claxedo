import { encodeSseData } from "../../../../agent-sdk-runtime/src/sse"

const decoder = new TextDecoder()

/** Canonical SSE byte encoder shared by both real streams. */
export function sseFrame(payload: unknown, id?: string) {
  return decoder.decode(encodeSseData(payload, id))
}

/** The bootstrap frame `cp/events` opens with: a heartbeat carrying the resume cursor. */
export function controlPlaneStreamHeartbeat(lastEventId?: number) {
  return sseFrame({ type: "heartbeat" }, String(lastEventId ?? 0))
}

/** The bootstrap frame `wr/events` opens with: a heartbeat carrying the resume cursor. */
export function workspaceStreamHeartbeat(lastEventId?: number) {
  return sseFrame({ type: "heartbeat" }, String(lastEventId ?? 0))
}
