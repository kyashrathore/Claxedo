export type TraceEvent = {
  name: string
  cat: string
  ph: string
  ts: number
  dur?: number
  pid: number
  tid: number
  args?: { data?: Record<string, unknown> }
}

export function traceText(value: unknown): string | undefined {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined
}

export function traceEventsFrom(payload: unknown): TraceEvent[] {
  if (!payload || typeof payload !== "object" || !("value" in payload) || !Array.isArray(payload.value)) return []
  return payload.value.filter((event): event is TraceEvent =>
    !!event &&
    typeof event === "object" &&
    "name" in event && typeof event.name === "string" &&
    "cat" in event && typeof event.cat === "string" &&
    "ph" in event && typeof event.ph === "string" &&
    "ts" in event && typeof event.ts === "number" &&
    "pid" in event && typeof event.pid === "number" &&
    "tid" in event && typeof event.tid === "number")
}
