import type { ServerEvent, SessionRef, SessionStatus } from "@/server"
import type { SoundChoice } from "./sounds"

export type AlertKind = "agent" | "permissions" | "errors"

export type AlertPreferences = {
  readonly notify: Readonly<Record<AlertKind, boolean>>
  readonly sound: Readonly<Record<AlertKind, SoundChoice>>
}

export type Alert = { readonly kind: AlertKind; readonly ref: SessionRef }

type LastStatus = Map<string, SessionStatus["kind"]>

function working(kind: SessionStatus["kind"] | undefined): boolean {
  return kind === "working" || kind === "retrying" || kind === "recovering"
}

function statusAlert(last: LastStatus, ref: SessionRef, status: SessionStatus): AlertKind | undefined {
  const previous = last.get(ref.sessionId)
  last.set(ref.sessionId, status.kind)
  if (status.kind === "idle" && working(previous)) return "agent"
  if (status.kind === "failed" && previous !== "failed") return "errors"
  return undefined
}

export function createAlertDetector(): (event: ServerEvent) => Alert | undefined {
  const last: LastStatus = new Map()
  return (event) => {
    if (event.type === "requestOpened") return event.request.kind === "permission" ? { kind: "permissions", ref: event.ref } : undefined
    if (event.type !== "statusChanged") return undefined
    const kind = statusAlert(last, event.ref, event.status)
    return kind ? { kind, ref: event.ref } : undefined
  }
}
