import { For, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import type { PluginCandidate } from "@/server"
import { marketplaceDictionary } from "../i18n"
import { activationSummary, installedHarnesses } from "../model"
import { CHIP } from "./chrome"

export function PluginFacts(props: { readonly plugin: PluginCandidate }): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  const status = () => {
    const summary = activationSummary(props.plugin)
    const state = t(summary.state.key)
    return summary.authority ? `${state} · ${t(summary.authority.key)}` : state
  }
  return (
    <dl
      data-component="agent-plugin-facts"
      class="grid grid-cols-[5.5rem_1fr] items-baseline gap-x-3 gap-y-1.5 border-b border-border-weak-base px-4 py-3 text-12-regular"
    >
      <dt class="text-text-weaker">{t("marketplace.facts.status")}</dt>
      <dd class="text-text-base">{status()}</dd>

      <dt class="text-text-weaker">{t("marketplace.facts.where")}</dt>
      <dd class="flex flex-wrap gap-1.5">
        <span class={CHIP}>{t("marketplace.facts.local")}</span>
        <span class={CHIP}>{t("marketplace.facts.cloud")}</span>
      </dd>

      <dt class="text-text-weaker">{t("marketplace.facts.projects")}</dt>
      <dd class="text-text-base">{t("marketplace.facts.everyProject")}</dd>

      <Show when={installedHarnesses(props.plugin).length > 0}>
        <dt class="text-text-weaker">{t("marketplace.facts.harnesses")}</dt>
        <dd class="flex flex-wrap gap-1.5">
          <For each={installedHarnesses(props.plugin)}>{(harness) => <span class={CHIP}>{harness}</span>}</For>
        </dd>
      </Show>
    </dl>
  )
}
