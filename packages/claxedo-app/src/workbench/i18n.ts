import type { Translations } from "@/i18n"

export const workbenchDictionary = {
  en: {
    "workbench.closePane": "Close Pane",
    "workbench.resize": "Resize panes",
    "workbench.dragPane": "Drag to move pane",
    "workbench.empty": "Nothing is open",
    "workbench.failed": "This pane failed",
    "workbench.retry": "Try again",
  },
  de: () => import("./locales/de"),
  es: () => import("./locales/es"),
  fr: () => import("./locales/fr"),
  ja: () => import("./locales/ja"),
  zh: () => import("./locales/zh"),
} satisfies Translations<
  | "workbench.closePane"
  | "workbench.resize"
  | "workbench.dragPane"
  | "workbench.empty"
  | "workbench.failed"
  | "workbench.retry"
>
