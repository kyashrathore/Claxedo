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
  | "surface.file.chooseOne"
  | "surface.file.chooseMany"
  | "surface.file.drop"
  | "surface.file.dropOrPaste"
  | "surface.file.reading"
  | "surface.combobox.empty"
  | "surface.combobox.searching"
  | "surface.combobox.remove"
  | "surface.reference.unavailable"

export const surfaceDictionary = {
  en: {
    "surface.source.agent": "{{name}} · agent reply",
    "surface.source.plugin": "{{name}} · app plugin",
    "surface.callout.dismiss": "Dismiss",
    "surface.reference.unavailable": "This control is drawn only on an app plugin's page.",
    "surface.board.movable": "movable item",
    "surface.board.grabbed": "Picked up. Arrow keys move it, Space or Enter drops it, Escape cancels.",
    "surface.board.moved": "Moved to {{column}}, position {{position}}",
    "surface.board.dropped": "Dropped in {{column}}, position {{position}}",
    "surface.board.cancelled": "Move cancelled",
    "surface.file.chooseOne": "Choose a file",
    "surface.file.chooseMany": "Choose files",
    "surface.file.drop": "or drop here",
    "surface.file.dropOrPaste": "or drop or paste here",
    "surface.file.reading": "Reading…",
    "surface.combobox.empty": "No matches",
    "surface.combobox.searching": "Searching…",
    "surface.combobox.remove": "Remove {{label}}",
  },
} satisfies Translations<SurfaceKey>
