import { Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import type { PluginCandidate } from "@/server"
import { Button, Tag } from "@/ui"
import { marketplaceDictionary } from "../i18n"
import { isBuiltIn, pluginLabel, type PluginStatus } from "../model"
import { PluginIconTile } from "./plugin-icon"
import { PluginStatusLine } from "./status"

const CARD = "flex h-16 items-start gap-3 rounded-lg border bg-surface-base p-3"

const TRAILING = "relative flex max-w-[50%] shrink-0 justify-end pt-0.5"

export type CardAction = { readonly label: string; readonly run: () => void; readonly disabled?: boolean }

export function CardTrailing(props: {
  readonly builtIn?: boolean
  readonly status?: PluginStatus
  readonly action?: CardAction
}): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  return (
    <div class={TRAILING}>
      <Show
        when={props.builtIn === true}
        fallback={
          <Show
            when={props.action}
            fallback={<Show when={props.status}>{(status) => <PluginStatusLine status={status()} />}</Show>}
          >
            {(action) => (
              <Button size="small" variant="neutral" disabled={action().disabled} onClick={() => action().run()}>
                {action().label}
              </Button>
            )}
          </Show>
        }
      >
        <Tag>{t("marketplace.builtIn")}</Tag>
      </Show>
    </div>
  )
}

export function DirectoryCardFrame(props: {
  readonly name: string
  readonly selected: boolean
  readonly onOpen: () => void
  readonly icon: JSX.Element
  readonly trailing: JSX.Element
  readonly children: JSX.Element
  readonly title?: string
  readonly agentPluginId?: string
}): JSX.Element {
  return (
    <div
      data-agent-plugin-card={props.agentPluginId}
      title={props.title}
      class={`relative ${CARD} transition-colors hover:bg-surface-raised-base`}
      classList={{ "border-border-strong-base": props.selected, "border-border-weak-base": !props.selected }}
    >
      <button
        type="button"
        data-directory-card-open
        aria-label={props.name}
        aria-pressed={props.selected}
        class="absolute inset-0 rounded-lg"
        onClick={() => props.onOpen()}
      />
      {props.icon}
      <div class="min-w-0 flex-1">
        <div class="truncate text-13-medium text-text-strong">{props.name}</div>
        {props.children}
      </div>
      {props.trailing}
    </div>
  )
}

export function DirectoryCard(props: {
  readonly plugin: PluginCandidate
  readonly status?: PluginStatus
  readonly selected: boolean
  readonly action?: CardAction
  readonly onOpen: () => void
}): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  const name = () => pluginLabel(props.plugin)
  const builtIn = () => isBuiltIn(props.plugin)
  return (
    <DirectoryCardFrame
      name={name()}
      selected={props.selected}
      onOpen={props.onOpen}
      title={props.plugin.relativePath ?? undefined}
      agentPluginId={props.plugin.pluginInstanceId}
      icon={<PluginIconTile icon={props.plugin.icon} name={name()} builtIn={builtIn()} />}
      trailing={<CardTrailing builtIn={builtIn()} status={props.status} action={props.action} />}
    >
      <Show
        when={builtIn() ? props.status : undefined}
        fallback={
          <p class="mt-0.5 truncate text-12-regular text-text-weak">
            {props.plugin.manifest?.description ?? t("marketplace.noDescription")}
          </p>
        }
      >
        {(status) => (
          <div class="mt-0.5 flex">
            <PluginStatusLine status={status()} />
          </div>
        )}
      </Show>
    </DirectoryCardFrame>
  )
}
