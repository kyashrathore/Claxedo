import { For, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import type { PluginCandidate, PluginToolGroup } from "@/server"
import { dictionary } from "../i18n"
import { isBuiltIn, pluginLabel, toolGroups } from "../model"
import { HEADING, ROW } from "./chrome"
import { PluginMcpServers } from "./detail-mcp"

function SkillRows(props: { readonly plugin: PluginCandidate; readonly onSkill: (name: string) => void }): JSX.Element {
  const t = useTranslator(dictionary)
  return (
    <section class="border-t border-border-weak-base px-4 pb-4">
      <h3 class={`${HEADING} pt-3 pb-2`}>
        {t("marketplace.skills")} <span class="text-text-weaker">{props.plugin.skills.length}</span>
      </h3>
      <Show
        when={props.plugin.skills.length > 0}
        fallback={<p class={`${ROW} text-12-regular text-text-weak`}>{t("marketplace.skills.none")}</p>}
      >
        <For each={props.plugin.skills}>
          {(entry) => (
            <button
              type="button"
              data-agent-plugin-skill={entry.name}
              class={`${ROW} mb-1.5 flex w-full items-center gap-2 text-left hover:bg-surface-raised-strong`}
              onClick={() => props.onSkill(entry.name)}
            >
              <span class="min-w-0 flex-1">
                <span class="block truncate text-12-medium text-text-strong">{entry.name}</span>
                <span class="block truncate text-11-regular text-text-weaker">{entry.description}</span>
              </span>
              <span aria-hidden="true" class="shrink-0 text-text-weaker">
                ›
              </span>
            </button>
          )}
        </For>
      </Show>
    </section>
  )
}

export function PluginSections(props: {
  readonly plugin: PluginCandidate
  readonly pending: boolean
  readonly onToolGroup: (group: PluginToolGroup, enabled: boolean) => void
  readonly onSkill: (name: string) => void
}): JSX.Element {
  const t = useTranslator(dictionary)
  const builtIn = () => isBuiltIn(props.plugin)
  const count = () => (builtIn() ? toolGroups(props.plugin).length : props.plugin.mcpServers.length)
  const heading = () => t(builtIn() ? "marketplace.toolGroups" : "marketplace.mcpServers")
  const region = () =>
    t(builtIn() ? "marketplace.toolGroups.region" : "marketplace.mcpServers.region", {
      name: pluginLabel(props.plugin),
    })
  return (
    <>
      <SkillRows plugin={props.plugin} onSkill={props.onSkill} />
      <section class="border-t border-border-weak-base px-4 pb-6" aria-label={region()}>
        <h3 class={`${HEADING} pt-3 pb-2`}>
          {heading()} <span class="text-text-weaker">{count()}</span>
        </h3>
        <Show
          when={count() > 0}
          fallback={
            <p class={`${ROW} text-12-regular text-text-weak`}>
              {t(builtIn() ? "marketplace.toolGroups.none" : "marketplace.mcpServers.none")}
            </p>
          }
        >
          <PluginMcpServers plugin={props.plugin} pending={props.pending} onToolGroup={props.onToolGroup} />
        </Show>
      </section>
    </>
  )
}
