import type { ServerEvent, SessionRef, SessionStatus } from "@/server"
import type { SoundChoice } from "./sounds"

export type AlertKind = "agent" | "permissions" | "errors"

export type AlertPreferences = {
  readonly notify: Readonly<Record<AlertKind, boolean>>
  readonly sound: Readonly<Record<AlertKind, SoundChoice>>
}

export type Alert = { readonly kind: AlertKind; readonly ref: SessionRef }

type Activity = { readonly kind?: SessionStatus["kind"]; readonly backgroundWork: boolean }

const QUIET: Activity = { backgroundWork: false }

function inProgress(activity: Activity): boolean {
  if (activity.kind === "working" || activity.kind === "retrying" || activity.kind === "recovering") return true
  return activity.backgroundWork && activity.kind !== "failed"
}

function activityAlert(previous: Activity, next: Activity): AlertKind | undefined {
  if (next.kind === "failed") return previous.kind === "failed" ? undefined : "errors"
  return inProgress(previous) && !inProgress(next) ? "agent" : undefined
}

type ActivityEvent = Extract<ServerEvent, { type: "statusChanged" | "backgroundWorkChanged" }>

function nextActivity(previous: Activity, event: ActivityEvent): Activity {
  return event.type === "statusChanged" ? { ...previous, kind: event.status.kind } : { ...previous, backgroundWork: event.active }
}

export function createAlertDetector(): (event: ServerEvent) => Alert | undefined {
  const last = new Map<string, Activity>()
  return (event) => {
    if (event.type === "requestOpened") return event.request.kind === "permission" ? { kind: "permissions", ref: event.ref } : undefined
    if (event.type !== "statusChanged" && event.type !== "backgroundWorkChanged") return undefined
    const previous = last.get(event.ref.sessionId) ?? QUIET
    const next = nextActivity(previous, event)
    last.set(event.ref.sessionId, next)
    const kind = activityAlert(previous, next)
    return kind ? { kind, ref: event.ref } : undefined
  }
}
