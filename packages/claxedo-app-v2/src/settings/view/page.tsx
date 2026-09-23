import { Show, type Component } from "solid-js"
import type { PageProps, SettingsSection } from "@/shell/types"
import { useTranslator } from "@/i18n"
import { dictionary } from "../i18n"
import { SettingsEmpty } from "./section"

export function createSettingsPage(sections: () => readonly SettingsSection[]): Component<PageProps> {
  return (props) => {
    const t = useTranslator(dictionary)
    const section = () => sections().find((entry) => entry.id === props.params.section)
    return (
      <div data-component="settings-content" data-section={props.params.section}>
        <Show when={section()} fallback={<SettingsEmpty>{t("settings.title")}</SettingsEmpty>}>
          {(entry) => {
            const View = entry().view
            return <View />
          }}
        </Show>
      </div>
    )
  }
}
