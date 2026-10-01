import { createEffect, createSignal, on, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import type { PluginCandidate, PluginHarness, PluginToolGroup } from "@/server"
import { marketplaceDictionary } from "../i18n"
import { isBuiltIn, pluginLabel, pluginStatus } from "../model"
import { PluginActions } from "./detail-actions"
import { PluginFacts } from "./detail-facts"
import { PluginSections } from "./detail-sections"
import { PluginIconTile } from "./plugin-icon"
import { SkillView } from "./skill-view"
import { PluginStatusLine } from "./status"

export type DetailHandlers = {
  readonly pending: boolean
  readonly onAdd: () => void
  readonly onActivate: (choice: boolean | null) => void
  readonly onUpdate: () => void
  readonly onToolGroup: (group: PluginToolGroup, enabled: boolean) => void
}

function DetailHeader(props: { readonly plugin: PluginCandidate }): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  const name = () => pluginLabel(props.plugin)
  const builtIn = () => isBuiltIn(props.plugin)
  return (
    <header class="flex items-start gap-3 border-b border-border-weak-base p-4">
      <PluginIconTile icon={props.plugin.icon} name={name()} size="pane" builtIn={builtIn()} />
      <div class="min-w-0 flex-1">
        <h2 class="truncate text-16-medium text-text-strong">{name()}</h2>
        <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-11-regular text-text-weaker">
          <Show when={props.plugin.manifest?.version}>{(version) => <span>v{version()}</span>}</Show>
          <span class="truncate">
            {builtIn() ? t("marketplace.builtIn") : (props.plugin.source?.label ?? t("marketplace.retainedArtifact"))}
          </span>
          <Show when={props.plugin.relativePath}>{(path) => <span class="truncate text-12-mono">{path()}</span>}</Show>
        </div>
        <Show when={pluginStatus(props.plugin)}>
          {(value) => (
            <div class="mt-1.5">
              <PluginStatusLine status={value()} wrap={builtIn()} />
            </div>
          )}
        </Show>
      </div>
    </header>
  )
}

function DetailNotes(props: { readonly plugin: PluginCandidate }): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  return (
    <>
      <Show when={props.plugin.manifest?.description}>
        {(description) => <p class="px-4 pt-3 text-13-regular text-text-base">{description()}</p>}
      </Show>
      <Show when={!isBuiltIn(props.plugin) && !props.plugin.sourceAvailable}>
        <p class="px-4 pt-2 text-12-regular text-text-weak">{t("marketplace.sourceUnavailable")}</p>
      </Show>
      <Show when={props.plugin.artifactError}>
        {(error) => <p class="px-4 pt-2 text-12-regular text-icon-critical-base">{error()}</p>}
      </Show>
    </>
  )
}

export function PluginDetails(
  props: DetailHandlers & {
    readonly plugin: PluginCandidate
    readonly harnesses: readonly PluginHarness[]
  },
): JSX.Element {
  const [skill, setSkill] = createSignal<string>()
  const name = () => pluginLabel(props.plugin)
  createEffect(
    on(
      () => props.plugin.pluginInstanceId,
      () => setSkill(undefined),
    ),
  )
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !skill()) return
    event.preventDefault()
    event.stopPropagation()
    setSkill(undefined)
  }
  return (
    <div class="flex h-full min-h-0 flex-col" onKeyDown={onKeyDown}>
      <Show
        when={skill()}
        fallback={
          <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <DetailHeader plugin={props.plugin} />
            <PluginFacts plugin={props.plugin} />
            <DetailNotes plugin={props.plugin} />
            <PluginActions {...props} />
            <PluginSections {...props} onSkill={setSkill} />
          </div>
        }
      >
        {(open) => (
          <SkillView
            pluginInstanceId={props.plugin.pluginInstanceId}
            pluginName={name()}
            skill={open()}
            onBack={() => setSkill(undefined)}
          />
        )}
      </Show>
    </div>
  )
}
