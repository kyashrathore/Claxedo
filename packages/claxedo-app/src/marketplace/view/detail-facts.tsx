import { For, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { useServer, type PluginCandidate } from "@/server"
import { marketplaceDictionary } from "../i18n"
import { activationSummary, installedHarnesses } from "../model"
import { CHIP } from "./chrome"
import { useHarnessLabel } from "./harness-label"

export function PluginFacts(props: { readonly plugin: PluginCandidate }): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  const label = useHarnessLabel()
  const server = useServer()
  const status = () => {
    const summary = activationSummary(props.plugin)
    const state = t(summary.state.key)
    if (!summary.authority) return state
    if (summary.authority.key !== "marketplace.authority.machine") return `${state} · ${t(summary.authority.key)}`
    const machine = server.capabilities()?.servingMachine?.name
    return `${state} · ${machine ? t("marketplace.authority.machine", { machine }) : t("marketplace.authority.machineUnnamed")}`
  }
  return (
    <dl
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
          <For each={installedHarnesses(props.plugin)}>{(harness) => <span class={CHIP}>{label(harness)}</span>}</For>
        </dd>
      </Show>
    </dl>
  )
}
