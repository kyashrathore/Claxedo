import { runtimeDiagnostic, withDir } from "../presentation-events"
import type { CompatContext } from "./context"

export function projectionDiagnostic(properties: {
  sessionID: string
  phase: "ingest" | "terminalize"
  code: string
  message: string
  severity?: "warn" | "error"
  eventType?: string
  issues?: string[]
  raw?: unknown
}) {
  return runtimeDiagnostic({
    sessionID: properties.sessionID,
    projection: "client-presentation",
    phase: properties.phase,
    code: properties.code,
    message: properties.message,
    severity: properties.severity ?? "warn",
    ...(properties.eventType ? { eventType: properties.eventType } : {}),
    ...(properties.issues?.length ? { issues: properties.issues } : {}),
    ...(properties.raw !== undefined ? { raw: properties.raw } : {}),
  })
}

export function lossyCompatDiagnostic(ctx: CompatContext, eventType: string, message: string, raw: unknown) {
  return withDir(ctx.directory, projectionDiagnostic({
    sessionID: ctx.sessionId,
    phase: "ingest",
    code: "projection.client_presentation.lossy_runtime_event",
    message,
    eventType,
    raw,
  }))
}

export function projectionException(
  ctx: CompatContext,
  phase: "ingest" | "terminalize",
  eventType: string | undefined,
  error: unknown,
) {
  return withDir(ctx.directory, projectionDiagnostic({
    sessionID: ctx.sessionId,
    phase,
    code: "projection.client_presentation.error",
    message: error instanceof Error ? error.message : String(error),
    severity: "error",
    ...(eventType ? { eventType } : {}),
  }))
}
