import type { Translations } from "@/i18n"

type SurfaceKey =
  | "surface.source.agent"
  | "surface.source.plugin"
  | "surface.callout.dismiss"
  | "surface.board.movable"
  | "surface.board.grabbed"
  | "surface.board.moved"
  | "surface.board.dropped"
  | "surface.board.cancelled"

export const surfaceDictionary = {
  en: {
    "surface.source.agent": "{{name}} · agent reply",
    "surface.source.plugin": "{{name}} · app plugin",
    "surface.callout.dismiss": "Dismiss",
    "surface.board.movable": "movable item",
    "surface.board.grabbed": "Picked up. Arrow keys move it, Space or Enter drops it, Escape cancels.",
    "surface.board.moved": "Moved to {{column}}, position {{position}}",
    "surface.board.dropped": "Dropped in {{column}}, position {{position}}",
    "surface.board.cancelled": "Move cancelled",
  },
} satisfies Translations<SurfaceKey>
