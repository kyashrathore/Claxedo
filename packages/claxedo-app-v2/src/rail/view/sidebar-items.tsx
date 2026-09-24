import { A } from "@solidjs/router"
import { createMemo, For, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { byOrder, fillPattern, RegistryIcon, useShellRegistries, useShellRoute, type PageEntry, type SidebarItem } from "@/shell"
import { dictionary } from "../i18n"

type SidebarLink = { readonly item: SidebarItem; readonly page: PageEntry }

export function SidebarItems(): JSX.Element {
  const t = useTranslator(dictionary)
  const registries = useShellRegistries()
  const routing = useShellRoute()
  const links = createMemo<readonly SidebarLink[]>(() =>
    byOrder(registries.sidebarItems.list()).flatMap((item) => {
      const page = registries.pages.list().find((candidate) => candidate.id === item.pageId)
      return page ? [{ item, page }] : []
    }),
  )
  const activePageId = () => {
    const route = routing.route()
    return route.kind === "page" ? route.page.id : undefined
  }
  return (
    <Show when={links().length > 0}>
      <nav class="rail-items" aria-label={t("rail.navigation")}>
        <For each={links()}>
          {(link) => (
            <A href={fillPattern(link.page.path)} class="rail-item" aria-current={activePageId() === link.page.id ? "page" : undefined}>
              <RegistryIcon name={link.item.icon} />
              <span>{link.item.title()}</span>
            </A>
          )}
        </For>
      </nav>
    </Show>
  )
}
