import { createMemo, Show, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useI18n, useTranslator } from "@/i18n"
import { dictionary } from "../i18n"
import { byOrder, useShellRegistries } from "../registries"
import type { PageEntry, PageProps } from "../types"
import { activeSectionId } from "./settings-sidebar"

export function SettingsPage(props: PageProps): JSX.Element {
  const t = useTranslator(dictionary)
  const registries = useShellRegistries()
  const section = createMemo(() => {
    const sections = byOrder(registries.settingsSections.list())
    const wanted = activeSectionId(props.params)
    return sections.find((candidate) => candidate.id === wanted) ?? sections[0]
  })
  return (
    <div class="settings-page" data-testid="settings-page">
      <Show
        when={section()}
        fallback={
          <>
            <h1 class="settings-section-title">{t("shell.settings")}</h1>
            <p class="settings-page-empty">{t("shell.settingsEmpty")}</p>
          </>
        }
      >
        {(active) => (
          <section class="settings-section" data-section={active().id} aria-labelledby={`settings-title-${active().id}`}>
            <h1 id={`settings-title-${active().id}`} class="settings-section-title">{active().title()}</h1>
            <Dynamic component={active().view} />
          </section>
        )}
      </Show>
    </div>
  )
}

export const settingsPage: PageEntry = {
  id: "settings",
  path: "/settings/:section?",
  title: () => useI18n().t("shell.settings"),
  icon: "settings",
  sidebar: "settings",
  order: 100,
  view: SettingsPage,
}
