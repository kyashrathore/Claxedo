import type { JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useTranslator } from "@/i18n"
import { IconButton } from "@/ui"
import { dictionary } from "../i18n"
import { useShellRoute } from "../router"
import { homePath, type RouteParams } from "../routes"
import type { PageEntry } from "../types"
import { RegistryIcon } from "./icon"
import { Region } from "./region"

export type PageTabProps = { readonly page: PageEntry; readonly params: RouteParams }

export function PageHeader(props: { readonly page: PageEntry }): JSX.Element {
  const t = useTranslator(dictionary)
  const routing = useShellRoute()
  return (
    <div class="shell-page-header" role="tablist" aria-label={t("shell.page")} data-testid="page-tab">
      <div role="tab" aria-selected="true" class="shell-page-tab">
        <RegistryIcon name={props.page.icon} />
        <span class="shell-page-title">{props.page.title()}</span>
      </div>
      <IconButton icon="close" variant="ghost" size="small" aria-label={t("shell.closePage")} data-testid="page-close" onClick={() => routing.navigate(homePath)} />
    </div>
  )
}

export function PageTab(props: PageTabProps): JSX.Element {
  return (
    <div class="shell-page" role="tabpanel" data-page={props.page.id} data-testid={`page-${props.page.id}`}>
      <Region name="page">
        <Dynamic component={props.page.view} params={props.params} />
      </Region>
    </div>
  )
}
