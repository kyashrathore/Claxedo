import type { Translations } from "@/i18n"
import { dictionary as ar } from "./locales/ar"
import { dictionary as br } from "./locales/br"
import { dictionary as bs } from "./locales/bs"
import { dictionary as da } from "./locales/da"
import { dictionary as de } from "./locales/de"
import { dictionary as es } from "./locales/es"
import { dictionary as fr } from "./locales/fr"
import { dictionary as ja } from "./locales/ja"
import { dictionary as ko } from "./locales/ko"
import { dictionary as no } from "./locales/no"
import { dictionary as pl } from "./locales/pl"
import { dictionary as ru } from "./locales/ru"
import { dictionary as th } from "./locales/th"
import { dictionary as tr } from "./locales/tr"
import { dictionary as zh } from "./locales/zh"
import { dictionary as zht } from "./locales/zht"

const en = {
  "rail.tasks": "Tasks",
  "rail.openTasks": "Open Tasks",
  "rail.marketplace": "Marketplace",
  "rail.openMarketplace": "Open Marketplace",
  "rail.projects": "Projects",
  "rail.collapseProject": "Collapse project",
  "rail.expandProject": "Expand project",
  "rail.newSessionTooltip": "New session",
  "rail.newSessionIn": "New session in {{project}}",
  "rail.archiveSession": "Archive {{title}}",
  "rail.sessionMenu": "Options for {{title}}",
  "rail.noMatches": "No sessions match the current view.",
  "rail.loadMore": "Load more",
  "rail.loadingMore": "Loading...",
  "rail.loadingSessions": "Loading sessions...",
  "rail.loadFailed": "Could not load sessions.",
  "rail.loadMoreFailed": "Could not load more sessions.",
  "rail.allLoaded": "All sessions loaded.",
  "rail.retry": "Retry",
  "rail.settings": "Settings",
  "rail.rename": "Rename",
  "rail.renameLabel": "Session title",
  "rail.save": "Save",
  "rail.cancel": "Cancel",
  "rail.archive": "Archive",
  "rail.delete": "Delete",
  "rail.deleteTitle": "Delete session",
  "rail.deleteConfirm": 'Delete session "{{name}}"?',
  "rail.deleteButton": "Delete session",
  "rail.renameFailed": "The session could not be renamed",
  "rail.archiveFailed": "The session could not be archived",
  "rail.deleteFailed": "The session could not be deleted",
} as const

export type RailKey = keyof typeof en

export const dictionary = { en, ar, br, bs, da, de, es, fr, ja, ko, no, pl, ru, th, tr, zh, zht } satisfies Translations<RailKey>
