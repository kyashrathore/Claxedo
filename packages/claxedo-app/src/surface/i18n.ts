import type { Translations } from "@/i18n"

type SurfaceKey = "surface.source.agent" | "surface.source.plugin" | "surface.callout.dismiss" | "surface.reference.unavailable"

export const surfaceDictionary = {
  en: {
    "surface.source.agent": "{{name}} · agent reply",
    "surface.source.plugin": "{{name}} · app plugin",
    "surface.callout.dismiss": "Dismiss",
    "surface.reference.unavailable": "This control is drawn only on an app plugin's page.",
  },
} satisfies Translations<SurfaceKey>
