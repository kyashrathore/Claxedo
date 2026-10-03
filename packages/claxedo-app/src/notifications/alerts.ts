import type { ServerEvent, SessionLocation } from "@/server"
import type { SoundChoice } from "./sounds"

export type AlertKind = "agent" | "permissions" | "errors"

export type AlertPreferences = {
  readonly notify: Readonly<Record<AlertKind, boolean>>
  readonly sound: Readonly<Record<AlertKind, SoundChoice>>
}

export type Alert = { readonly kind: AlertKind; readonly ref: SessionLocation; readonly title?: string }

function alertKind(event: Extract<ServerEvent, { type: "attentionRaised" }>): AlertKind | undefined {
  if (event.event.kind !== "outcome") return "permissions"
  if (event.event.outcome === "failed") return "errors"
  return event.event.outcome === "completed" ? "agent" : undefined
}

export function createAlertDetector(): (event: ServerEvent) => Alert | undefined {
  return (event) => {
    if (event.type !== "attentionRaised") return undefined
    if (event.delivery === "replay" || event.parentSessionId) return undefined
    const kind = alertKind(event)
    return kind ? { kind, ref: event.ref, ...(event.title ? { title: event.title } : {}) } : undefined
  }
}
