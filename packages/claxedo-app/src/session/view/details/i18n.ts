import { useTranslator, type Translations } from "@/i18n"

const en = {
  "details.label": "Session details",
  "details.environment": "Environment",
  "details.where.thisComputer": "This computer",
  "details.where.otherMachine": "Another machine",
  "details.state.offline": "Offline",
  "details.state.paused": "Paused",
  "details.state.asleep": "Asleep",
  "details.state.starting": "Starting",
  "details.state.failed": "Failed",
  "details.worktree": "Worktree",
  "details.branch.detached": "Detached HEAD",
  "details.branch.unknown": "No branch",
  "details.background": "Background tasks",
  "details.background.running": "{{count}} running",
  "details.background.none": "None",
  "details.background.show": "Show background tasks",
  "details.background.hide": "Hide background tasks",
  "details.background.agents.one": "{{count}} background agent",
  "details.background.agents.other": "{{count}} background agents",
  "details.background.shells.one": "{{count}} shell",
  "details.background.shells.other": "{{count}} shells",
  "details.background.other.one": "{{count}} other task",
  "details.background.other.other": "{{count}} other tasks",
}

export type DetailsKey = keyof typeof en

const detailsDictionary = { en } satisfies Translations<DetailsKey>

export const useDetailsText = () => useTranslator(detailsDictionary)

export type DetailsText = ReturnType<typeof useDetailsText>
