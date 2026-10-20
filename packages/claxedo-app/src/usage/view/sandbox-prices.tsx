import { createMemo, For, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { openExternal } from "@/lib/external-link"
import type { MachineTime, MachineTimeProvider } from "@/server"
import { usageDictionary } from "../i18n"
import { useUsageFormats } from "./usage-formats"

function ProviderPrices(props: { readonly provider: MachineTimeProvider }): JSX.Element {
  const t = useTranslator(usageDictionary)
  const host = () => new URL(props.provider.source.url).host
  return (
    <li class="usage-hint">
      {t("usage.sandbox.prices", { provider: props.provider.label, date: props.provider.source.readOn })}{" "}
      <a href={props.provider.source.url} class="usage-link" onClick={(event) => { event.preventDefault(); openExternal(props.provider.source.url) }}>{host()}</a>
      <Show when={props.provider.excludes}>{(excludes) => <> {t("usage.sandbox.excludes", { what: excludes() })}</>}</Show>
    </li>
  )
}

export function SandboxPrices(props: { readonly time: MachineTime }): JSX.Element {
  const t = useTranslator(usageDictionary)
  const format = useUsageFormats()
  const unpriced = createMemo(() => props.time.workspaces.filter((machine) => machine.costUsd === undefined))
  const unpricedMs = () => unpriced().reduce((total, machine) => total + machine.activeMs, 0)
  return (
    <ul class="usage-section-notes">
      <Show when={unpricedMs() > 0}>
        <li class="usage-hint">{t("usage.sandbox.unpriced", { time: format.duration(unpricedMs()), providers: [...new Set(unpriced().map((machine) => machine.providerLabel))].join(", ") })}</li>
      </Show>
      <For each={props.time.providers}>{(provider) => <ProviderPrices provider={provider} />}</For>
    </ul>
  )
}
