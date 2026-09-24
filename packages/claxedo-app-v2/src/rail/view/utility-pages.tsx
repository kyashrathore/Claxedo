import type { JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { MarketplacePage } from "@/marketplace"
import type { PageEntry } from "@/shell"
import { dictionary } from "../i18n"

export const TASKS_PATH = "/tasks"
export const MARKETPLACE_PATH = "/marketplace"

type TitleKey = "rail.tasks" | "rail.marketplace"

function titled(key: TitleKey): () => string {
  return () => useTranslator(dictionary)(key)
}

function PageTitle(props: { readonly title: () => string }): JSX.Element {
  return (
    <div class="h-full overflow-auto px-6 py-5">
      <h1 class="text-base font-medium text-text-strong">{props.title()}</h1>
    </div>
  )
}

const tasksTitle = titled("rail.tasks")
const marketplaceTitle = titled("rail.marketplace")

export const tasksPage: PageEntry = {
  id: "tasks",
  path: TASKS_PATH,
  title: tasksTitle,
  icon: "checklist",
  sidebar: "main",
  tab: true,
  view: () => <PageTitle title={tasksTitle} />,
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
