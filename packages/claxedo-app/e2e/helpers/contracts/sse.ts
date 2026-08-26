import { encodeSseData } from "../../../../agent-sdk-runtime/src/sse"
import { connectedFrame } from "../../../../claxedo-local-server/src/opencode/compat-routes/events"

const decoder = new TextDecoder()

/** Canonical SSE byte encoder shared by both real runtime stream families. */
export function sseFrame(payload: unknown, id?: string) {
  return decoder.decode(encodeSseData(payload, id))
}

export function centralStreamHeartbeat(lastEventId?: number) {
  return sseFrame(connectedFrame("initial"), String(lastEventId ?? 0))
}

export function workspaceStreamHeartbeat(lastEventId?: number) {
  return sseFrame({ type: "heartbeat" }, String(lastEventId ?? 0))
}

export function runtimeStreamHeartbeat() {
  return sseFrame({ type: "heartbeat" })
}
