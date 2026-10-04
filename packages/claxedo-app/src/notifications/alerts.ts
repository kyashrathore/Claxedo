import type { SessionAttention } from "@/session"
import type { SoundChoice } from "./sounds"

export type AlertKind = "agent" | "permissions" | "errors"

export type AlertPreferences = {
  readonly notify: Readonly<Record<AlertKind, boolean>>
  readonly sound: Readonly<Record<AlertKind, SoundChoice>>
}

export const ALERT_OF: Readonly<Record<SessionAttention["kind"], AlertKind>> = { finished: "agent", failed: "errors", waiting: "permissions" }
