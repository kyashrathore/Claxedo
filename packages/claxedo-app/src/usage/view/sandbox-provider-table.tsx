import { For, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { usageDictionary } from "../i18n"
import type { SandboxProviderTotal } from "../sandbox-groups"
import { useUsageFormats } from "./usage-formats"

export function SandboxProviderTable(props: { readonly totals: readonly SandboxProviderTotal[] }): JSX.Element {
  const t = useTranslator(usageDictionary)
  const format = useUsageFormats()
  return (
    <table class="usage-table" aria-label={t("usage.sandbox.providers")}>
      <thead>
        <tr>
          <th scope="col" class="usage-table-lead">{t("usage.sandbox.provider")}</th>
          <th scope="col">{t("usage.sandbox.time")}</th>
          <th scope="col">{t("usage.sandbox.cost")}</th>
        </tr>
      </thead>
      <tbody>
        <For each={props.totals}>
          {(total) => (
            <tr>
              <th scope="row" class="usage-table-lead"><span class="usage-table-name">{total.label}</span></th>
              <td>{format.duration(total.activeMs)}</td>
              <td>{format.spend(total.cost)}</td>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  )
}
