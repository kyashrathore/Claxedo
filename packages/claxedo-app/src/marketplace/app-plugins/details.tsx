import { Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { marketplaceDictionary } from "../i18n"
import { PluginIconTile } from "../view/plugin-icon"
import { DetailHeaderFrame } from "../view/detail-header"
import { AppPluginAccessList } from "./access-list"
import type { AppPluginActions } from "./actions"
import { AppPluginDetailActions } from "./detail-actions"
import { AppPluginFacts } from "./facts"
import { appPluginStatus, type AppPluginEntry } from "./model"

function AppPluginHeader(props: { readonly entry: AppPluginEntry }): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  return (
    <DetailHeaderFrame
      name={props.entry.name}
      icon={<PluginIconTile name={props.entry.name} size="pane" />}
      version={props.entry.install?.version ?? props.entry.listing?.latest}
      status={appPluginStatus(props.entry)}
      wrapStatus
    >
      <span>{t("marketplace.app.kind")}</span>
      <span class="truncate text-12-mono">{props.entry.id}</span>
    </DetailHeaderFrame>
  )
}

export function AppPluginDetails(props: { readonly entry: AppPluginEntry; readonly canManage: boolean; readonly actions: AppPluginActions }): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  return (
    <div class="flex h-full min-h-0 flex-col">
      <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <AppPluginHeader entry={props.entry} />
        <AppPluginFacts entry={props.entry} />
        <Show when={props.entry.description}>{(description) => <p class="px-4 pt-3 text-13-regular text-text-base">{description()}</p>}</Show>
        <Show when={!props.entry.install && !props.canManage}>
          <p class="px-4 pt-2 text-12-regular text-text-weak">{t("marketplace.app.askAdmin")}</p>
        </Show>
        <AppPluginDetailActions entry={props.entry} canManage={props.canManage} actions={props.actions} />
        <div class="border-t border-border-weak-base px-4 py-3">
          <AppPluginAccessList manifest={props.entry.manifest} />
        </div>
      </div>
    </div>
  )
}
