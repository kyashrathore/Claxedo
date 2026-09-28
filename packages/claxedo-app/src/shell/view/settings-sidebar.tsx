import { A } from "@solidjs/router"
import { createMemo, For, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { shellDictionary } from "../i18n"
import { byOrder, useShellRegistries } from "../registries"
import { useShellRoute } from "../router"
import { homePath, settingsPath } from "../routes"
import { ClaxedoIcon as Icon } from "@/ui"
import type { SettingsSection } from "../types"
import "./settings.css"

const groups: readonly SettingsSection["group"][] = ["account", "workspace", "app"]

export function activeSectionId(params: Readonly<Record<string, string>>): string | undefined {
  return params.section
}

export function SettingsSidebar(): JSX.Element {
  const t = useTranslator(shellDictionary)
  const registries = useShellRegistries()
  const routing = useShellRoute()
  const active = createMemo(() => {
    const route = routing.route()
    return route.kind === "page" ? activeSectionId(route.params) : undefined
  })
  const sections = createMemo(() => byOrder(registries.settingsSections.list()))
  return (
    <div class="settings-nav" data-testid="settings-sidebar">
      <A href={homePath} class="sidebar-row settings-nav-row">
        <Icon name="arrow-left" />
        <span>{t("shell.back")}</span>
      </A>
      <h2 class="settings-nav-title">{t("shell.settings")}</h2>
      <For each={groups}>
        {(group) => (
          <Show when={sections().some((section) => section.group === group)}>
            <div class="settings-nav-group" role="group" aria-label={t(`shell.settingsGroup.${group}`)}>
              <div class="sidebar-section-label settings-nav-group-title" aria-hidden="true">{t(`shell.settingsGroup.${group}`)}</div>
              <For each={sections().filter((section) => section.group === group)}>
                {(section) => (
                  <A href={settingsPath(section.id)} class="sidebar-row settings-nav-row" aria-current={active() === section.id ? "page" : undefined}>
                    {section.title()}
                  </A>
                )}
              </For>
            </div>
          </Show>
        )}
      </For>
    </div>
  )
}
