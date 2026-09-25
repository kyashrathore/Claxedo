export type StreamSignal = "heartbeat" | "replayGap"

export function streamSignalOf(frame: unknown): StreamSignal | undefined {
  const type = frame && typeof frame === "object" ? (frame as { type?: unknown }).type : undefined
  if (type === "heartbeat") return "heartbeat"
  if (type === "stream.replay-gap") return "replayGap"
  return undefined
}
