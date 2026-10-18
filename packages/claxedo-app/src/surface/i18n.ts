import type { Translations } from "@/i18n"

type SurfaceKey = "surface.source.agent" | "surface.source.plugin" | "surface.callout.dismiss"

export const surfaceDictionary = {
  en: {
    "surface.source.agent": "{{name}} · agent reply",
    "surface.source.plugin": "{{name}} · app plugin",
    "surface.callout.dismiss": "Dismiss",
  },
} satisfies Translations<SurfaceKey>
