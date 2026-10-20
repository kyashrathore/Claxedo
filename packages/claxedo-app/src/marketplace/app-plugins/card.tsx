import { Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { Button } from "@/ui"
import { marketplaceDictionary } from "../i18n"
import { PluginIconTile } from "../view/plugin-icon"
import { PluginStatusLine } from "../view/status"
import type { AppPluginActions } from "./actions"
import { MAIN_ACTION_LABEL, runMainAction } from "./main-action"
import { appPluginMainAction, appPluginStatus, type AppPluginEntry } from "./model"

const CARD = "relative flex h-16 items-start gap-3 rounded-lg border bg-surface-base p-3 transition-colors hover:bg-surface-raised-base"

function CardTrailing(props: { readonly entry: AppPluginEntry; readonly canManage: boolean; readonly actions: AppPluginActions }): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  const action = () => {
    const main = appPluginMainAction(props.entry, props.canManage)
    return main === "install" || main === "turnOn" ? main : undefined
  }
  const status = () => appPluginStatus(props.entry)
  return (
    <div class="relative flex max-w-[50%] shrink-0 justify-end pt-0.5">
      <Show when={action()} fallback={<Show when={status()}>{(value) => <PluginStatusLine status={value()} />}</Show>}>
        {(main) => (
          <Button
            size="small"
            variant="neutral"
            disabled={props.actions.pending() === props.entry.id}
            onClick={() => void runMainAction(props.actions, main(), props.entry)}
          >
            {t(MAIN_ACTION_LABEL[main()])}
          </Button>
        )}
      </Show>
    </div>
  )
}

export function AppPluginCard(props: {
  readonly entry: AppPluginEntry
  readonly selected: boolean
  readonly canManage: boolean
  readonly actions: AppPluginActions
  readonly onOpen: () => void
}): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  return (
    <div
      class={CARD}
      classList={{ "border-border-strong-base": props.selected, "border-border-weak-base": !props.selected }}
    >
      <button
        type="button"
        data-directory-card-open
        aria-label={props.entry.name}
        aria-pressed={props.selected}
        class="absolute inset-0 rounded-lg"
        onClick={() => props.onOpen()}
      />
      <PluginIconTile name={props.entry.name} />
      <div class="min-w-0 flex-1">
        <div class="truncate text-13-medium text-text-strong">{props.entry.name}</div>
        <p class="mt-0.5 truncate text-12-regular text-text-weak">{props.entry.description ?? t("marketplace.noDescription")}</p>
      </div>
      <CardTrailing entry={props.entry} canManage={props.canManage} actions={props.actions} />
    </div>
  )
}
