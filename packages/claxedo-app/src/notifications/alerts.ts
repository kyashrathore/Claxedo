import { NO_BACKGROUND_WORK, sessionStatusWithBackgroundWork, type BackgroundWork, type ServerEvent, type SessionLocation, type SessionStatus } from "@/server"
import type { SoundChoice } from "./sounds"

export type AlertKind = "agent" | "permissions" | "errors"

export type AlertPreferences = {
  readonly notify: Readonly<Record<AlertKind, boolean>>
  readonly sound: Readonly<Record<AlertKind, SoundChoice>>
}

export type Alert = { readonly kind: AlertKind; readonly ref: SessionLocation }

type Activity = { readonly kind?: SessionStatus["kind"]; readonly backgroundWork: BackgroundWork }

export function createAlertDetector(): (event: ServerEvent) => Alert | undefined {
  const last = new Map<string, Activity>()
  return (event) => {
    if (event.type === "requestOpened") return event.request.kind === "permission" ? { kind: "permissions", ref: event.ref } : undefined
    if (event.type !== "statusChanged" && event.type !== "backgroundWorkChanged") return undefined
    const previous = last.get(event.ref.sessionId) ?? { backgroundWork: NO_BACKGROUND_WORK }
    if (event.type === "backgroundWorkChanged") {
      last.set(event.ref.sessionId, { ...previous, backgroundWork: event.work })
      return undefined
    }
    last.set(event.ref.sessionId, { ...previous, kind: event.status.kind })
    const after = sessionStatusWithBackgroundWork(event.status, previous.backgroundWork).kind
    if (after === "failed" && previous.kind !== "failed") return { kind: "errors", ref: event.ref }
    if (after === "idle" && (previous.kind === "working" || previous.kind === "retrying")) return { kind: "agent", ref: event.ref }
    return undefined
  }
}
