import { useTranslator } from "@/i18n"
import { MarketplacePage } from "@/marketplace"
import { TASKS_PAGE_PATH, TasksPage } from "@/tasks"
import type { PageEntry } from "@/shell"
import { dictionary } from "../i18n"

export const TASKS_PATH = "/tasks"
export const MARKETPLACE_PATH = "/marketplace"

type TitleKey = "rail.tasks" | "rail.marketplace"

function titled(key: TitleKey): () => string {
  return () => useTranslator(dictionary)(key)
}

const tasksTitle = titled("rail.tasks")
const marketplaceTitle = titled("rail.marketplace")

export const tasksPage: PageEntry = {
  id: "tasks",
  path: TASKS_PAGE_PATH,
  title: tasksTitle,
  icon: "checklist",
  sidebar: "main",
  tab: true,
  view: TasksPage,
}

export const marketplacePage: PageEntry = {
  id: "marketplace",
  path: MARKETPLACE_PATH,
  title: marketplaceTitle,
  icon: "marketplace",
  sidebar: "main",
  tab: true,
  view: MarketplacePage,
}
