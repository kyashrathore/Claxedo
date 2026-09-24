import type { JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import type { SessionRowView } from "@/session"
import { Icon, Menu } from "@/ui"
import { dictionary } from "../i18n"
import type { SessionActions } from "./session-actions"

export function SessionMenu(props: { readonly row: SessionRowView; readonly actions: SessionActions }): JSX.Element {
  const t = useTranslator(dictionary)
  return (
    <Menu placement="bottom-end">
      <Menu.Trigger class="rail-row-menu" aria-label={t("rail.actions", { title: props.row.title })}>
        <Icon name="three-dots" size="small" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content>
          <Menu.Item onSelect={() => props.actions.rename(props.row)}>{t("rail.rename")}</Menu.Item>
          <Menu.Item onSelect={() => props.actions.archive(props.row)}>{t("rail.archive")}</Menu.Item>
          <Menu.Separator />
          <Menu.Item onSelect={() => props.actions.remove(props.row)}>{t("rail.delete")}</Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu>
  )
}
