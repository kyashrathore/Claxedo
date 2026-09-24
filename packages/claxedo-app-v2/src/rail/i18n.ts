import type { Translations } from "@/i18n"

export type RailKey =
  | "rail.navigation"
  | "rail.sessions"
  | "rail.search"
  | "rail.clearSearch"
  | "rail.empty"
  | "rail.noMatches"
  | "rail.loadMore"
  | "rail.loading"
  | "rail.failed"
  | "rail.archived"
  | "rail.showArchived"
  | "rail.settings"
  | "rail.status.pending"
  | "rail.status.idle"
  | "rail.status.working"
  | "rail.status.waiting"
  | "rail.status.retrying"
  | "rail.status.recovering"
  | "rail.status.failed"

export const dictionary = {
  en: {
    "rail.navigation": "Pages",
    "rail.sessions": "Sessions",
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
    "rail.status.pending": "Creating",
    "rail.status.idle": "Idle",
    "rail.status.working": "Working",
    "rail.status.waiting": "Waiting on you",
    "rail.status.retrying": "Retrying",
    "rail.status.recovering": "Recovering",
    "rail.status.failed": "Failed",
  },
  de: {
    "rail.sessions": "Sitzungen",
    "rail.search": "Sitzungen durchsuchen",
    "rail.settings": "Einstellungen",
  },
} satisfies Translations<RailKey>
