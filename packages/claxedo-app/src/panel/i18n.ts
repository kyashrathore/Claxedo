import type { Translations } from "@/i18n"

const en = {
  "panel.tab.review": "Review",
  "panel.tab.context": "Context",
  "panel.tab.subagent": "Subagent",
  "panel.tab.plan": "Plan",
  "panel.tab.closeSubagent": "Close subagent",
  "panel.label": "Workspace panel",
  "panel.open": "Open workspace panel",
  "panel.close": "Close workspace panel",
  "panel.details.show": "Show session details",
  "panel.maximize": "Maximize workspace panel",
  "panel.restore": "Restore workspace panel width",
  "panel.resize": "Resize workspace panel",
  "panel.navigator.resize": "Resize navigator",
  "panel.addTab": "Add workspace tab",
  "panel.add.file": "File",
  "panel.add.browser": "Browser",
  "panel.noPlacement": "Select a workspace to use this panel.",
  "panel.connecting": "Connecting to workspace...",
  "panel.unavailable": "This workspace isn't available.",
  "panel.markdown.preview": "Preview markdown",
  "panel.markdown.source": "Show source",
}

type PanelKey = keyof typeof en

export const panelDictionary = {
  en,
  ar: () => import("./locales/ar"),
  br: () => import("./locales/br"),
  bs: () => import("./locales/bs"),
  da: () => import("./locales/da"),
  de: () => import("./locales/de"),
  es: () => import("./locales/es"),
  fr: () => import("./locales/fr"),
  ja: () => import("./locales/ja"),
  ko: () => import("./locales/ko"),
  no: () => import("./locales/no"),
  pl: () => import("./locales/pl"),
  ru: () => import("./locales/ru"),
  th: () => import("./locales/th"),
  tr: () => import("./locales/tr"),
  zh: () => import("./locales/zh"),
  zht: () => import("./locales/zht"),
} satisfies Translations<PanelKey>
