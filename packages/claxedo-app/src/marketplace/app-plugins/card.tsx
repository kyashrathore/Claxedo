import type { JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { marketplaceDictionary } from "../i18n"
import { CardTrailing, DirectoryCardFrame, type CardAction } from "../view/card"
import { PluginIconTile } from "../view/plugin-icon"
import type { AppPluginActions } from "./actions"
import { MAIN_ACTION_LABEL, runMainAction } from "./main-action"
import { appPluginMainAction, appPluginStatus, type AppPluginEntry } from "./model"

export function AppPluginCard(props: {
  readonly entry: AppPluginEntry
  readonly selected: boolean
  readonly canManage: boolean
  readonly actions: AppPluginActions
  readonly onOpen: () => void
}): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  const action = (): CardAction | undefined => {
    const main = appPluginMainAction(props.entry, props.canManage)
    if (main !== "install" && main !== "turnOn") return undefined
    return { label: t(MAIN_ACTION_LABEL[main]), run: () => void runMainAction(props.actions, main, props.entry), disabled: props.actions.pending() === props.entry.id }
  }
  return (
    <DirectoryCardFrame
      name={props.entry.name}
      selected={props.selected}
      onOpen={props.onOpen}
      icon={<PluginIconTile name={props.entry.name} />}
      trailing={<CardTrailing status={appPluginStatus(props.entry)} action={action()} />}
    >
      <p class="mt-0.5 truncate text-12-regular text-text-weak">{props.entry.description ?? t("marketplace.noDescription")}</p>
    </DirectoryCardFrame>
  )
}
