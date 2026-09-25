import { Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import type { PluginCandidate } from "@/server"
import { Button, Tag } from "@/ui"
import { dictionary } from "../i18n"
import { isBuiltIn, pluginLabel, type PluginStatus } from "../model"
import type { PersonalEntry } from "../sections"
import { PluginIconTile } from "./plugin-icon"
import { PluginStatusLine } from "./status"

const CARD = "flex h-16 items-start gap-3 rounded-lg border bg-surface-base p-3"

const TRAILING = "relative flex max-w-[50%] shrink-0 justify-end pt-0.5"

export type CardAction = { readonly label: string; readonly run: () => void; readonly disabled?: boolean }

function CardTrailing(props: {
  readonly builtIn: boolean
  readonly status?: PluginStatus
  readonly action?: CardAction
}): JSX.Element {
  const t = useTranslator(dictionary)
  return (
    <div class={TRAILING}>
      <Show
        when={props.builtIn}
        fallback={
          <Show
            when={props.action}
            fallback={<Show when={props.status}>{(status) => <PluginStatusLine status={status()} />}</Show>}
          >
            {(action) => (
              <Button size="small" variant="secondary" disabled={action().disabled} onClick={() => action().run()}>
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

export function DirectoryCard(props: {
  readonly plugin: PluginCandidate
  readonly status?: PluginStatus
  readonly selected: boolean
  readonly action?: CardAction
  readonly onOpen: () => void
}): JSX.Element {
  const t = useTranslator(dictionary)
  const name = () => pluginLabel(props.plugin)
  const builtIn = () => isBuiltIn(props.plugin)
  return (
    <div
      data-agent-plugin-card={props.plugin.pluginInstanceId}
      title={props.plugin.relativePath ?? undefined}
      class={`relative ${CARD} transition-colors hover:bg-surface-raised-base`}
      classList={{ "border-border-strong-base": props.selected, "border-border-weak-base": !props.selected }}
    >
      <button
        type="button"
        data-directory-card-open
        aria-label={name()}
        aria-pressed={props.selected}
        class="absolute inset-0 rounded-lg"
        onClick={() => props.onOpen()}
      />
      <PluginIconTile icon={props.plugin.icon} name={name()} builtIn={builtIn()} />
      <div class="min-w-0 flex-1">
        <div class="truncate text-13-medium text-text-strong">{name()}</div>
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
      </div>
      <CardTrailing builtIn={builtIn()} status={props.status} action={props.action} />
    </div>
  )
}

const PERSONAL_TAG = "shrink-0 rounded-full border border-border-weak-base px-2 py-px text-11-medium"

export function PersonalCard(props: {
  readonly entry: PersonalEntry
  readonly selected?: boolean
  readonly onOpen: () => void
}): JSX.Element {
  const t = useTranslator(dictionary)
  return (
    <button
      type="button"
      data-agent-plugin-personal={props.entry.name}
      aria-label={props.entry.name}
      aria-pressed={props.selected}
      title={props.entry.root}
      onClick={() => props.onOpen()}
      class={`${CARD} text-left ${props.selected ? "border-border-base" : "border-border-weak-base hover:border-border-base"}`}
    >
      <PluginIconTile name={props.entry.name} />
      <div class="min-w-0 flex-1">
        <div class="truncate text-13-medium text-text-strong">{props.entry.name}</div>
        <div class="mt-1 flex gap-1.5 overflow-hidden">
          <span class={`${PERSONAL_TAG} text-text-weak`}>{props.entry.harnessId}</span>
          <Show when={props.entry.kind === "skill"}>
            <span class={`${PERSONAL_TAG} text-text-weaker`}>{t("marketplace.personal.skillTag")}</span>
          </Show>
          <Show when={props.entry.kind === "plugin" ? props.entry.marketplace : undefined}>
            {(marketplace) => <span class={`${PERSONAL_TAG} text-text-weaker`}>{marketplace()}</span>}
          </Show>
        </div>
      </div>
    </button>
  )
}
