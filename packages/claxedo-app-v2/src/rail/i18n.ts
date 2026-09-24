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
  "rail.navigation": "Pages",
  "rail.sessions": "Sessions",
  "rail.newSession": "New session",
  "rail.search": "Search sessions",
  "rail.clearSearch": "Clear search",
  "rail.empty": "No sessions yet",
  "rail.noMatches": "No sessions match",
  "rail.loadMore": "Load more",
  "rail.loading": "Loading sessions",
  "rail.failed": "Sessions could not be loaded: {{message}}",
  "rail.archived": "Archived",
  "rail.showArchived": "Show archived",
  "rail.settings": "Settings",
  "rail.actions": "Actions for {{title}}",
  "rail.rename": "Rename",
  "rail.renameLabel": "Session title",
  "rail.save": "Save",
  "rail.cancel": "Cancel",
  "rail.archive": "Archive",
  "rail.unarchive": "Unarchive",
  "rail.delete": "Delete",
  "rail.deleteTitle": "Delete session",
  "rail.deleteConfirm": 'Delete session "{{name}}"?',
  "rail.deleteButton": "Delete session",
  "rail.renameFailed": "The session could not be renamed",
  "rail.archiveFailed": "The session could not be archived",
  "rail.deleteFailed": "The session could not be deleted",
  "rail.createFailed": "The session could not be created",
  "rail.status.pending": "Creating",
  "rail.status.idle": "Idle",
  "rail.status.working": "Working",
  "rail.status.waiting": "Waiting on you",
  "rail.status.retrying": "Retrying",
  "rail.status.recovering": "Recovering",
  "rail.status.failed": "Failed",
} as const

export type RailKey = keyof typeof en

export const dictionary = { en, ar, br, bs, da, de, es, fr, ja, ko, no, pl, ru, th, tr, zh, zht } satisfies Translations<RailKey>
