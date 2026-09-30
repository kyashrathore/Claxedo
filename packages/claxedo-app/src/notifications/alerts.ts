import { sessionStatusWithBackgroundWork, type ServerEvent, type SessionRef, type SessionStatus } from "@/server"
import type { SoundChoice } from "./sounds"

export type AlertKind = "agent" | "permissions" | "errors"

export type AlertPreferences = {
  readonly notify: Readonly<Record<AlertKind, boolean>>
  readonly sound: Readonly<Record<AlertKind, SoundChoice>>
}

export type Alert = { readonly kind: AlertKind; readonly ref: SessionRef }

type Activity = { readonly status?: SessionStatus; readonly backgroundWork: boolean }

const QUIET: Activity = { backgroundWork: false }

function shown(activity: Activity): SessionStatus["kind"] | undefined {
  return activity.status && sessionStatusWithBackgroundWork(activity.status, activity.backgroundWork).kind
}

function turnRunning(kind: SessionStatus["kind"] | undefined): boolean {
  return kind === "working" || kind === "retrying" || kind === "recovering"
}

function activityAlert(previous: Activity, next: Activity): AlertKind | undefined {
  const [before, after] = [shown(previous), shown(next)]
  if (after === "failed") return before === "failed" ? undefined : "errors"
  return turnRunning(before) && after === "idle" ? "agent" : undefined
}

type ActivityEvent = Extract<ServerEvent, { type: "statusChanged" | "backgroundWorkChanged" }>

function nextActivity(previous: Activity, event: ActivityEvent): Activity {
  return event.type === "statusChanged" ? { ...previous, status: event.status } : { ...previous, backgroundWork: event.active }
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
