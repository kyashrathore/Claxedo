import { For, Show, type JSX } from "solid-js"
import { useI18n, useTranslator } from "@/i18n"
import { harnessIcon } from "@/lib/harness-catalog"
import { ClaxedoIcon, Collapsible, ProviderIcon } from "@/ui"
import { usageDictionary } from "../i18n"
import type { QuotaAccount } from "../model"
import { quotaAccountTitle } from "./quota-windows"

export function NotConnectedAgents(props: { readonly accounts: readonly QuotaAccount[] }): JSX.Element {
  const t = useTranslator(usageDictionary)
  const i18n = useI18n()
  const names = () => new Intl.ListFormat(i18n.intlTag(), { style: "short", type: "unit" }).format(props.accounts.map(quotaAccountTitle))
  return (
    <Collapsible class="usage-offline">
      <Collapsible.Trigger class="usage-offline-toggle">
        <ClaxedoIcon name="chevron-right" size="small" class="usage-offline-chevron" />
        <span class="usage-offline-title">{t("usage.quota.notConnected")}</span>
        <span class="usage-offline-count">{props.accounts.length}</span>
        <span class="usage-offline-names">{names()}</span>
      </Collapsible.Trigger>
      <Collapsible.Content class="usage-offline-body">
        <p class="usage-offline-hint">{t("usage.quota.notConnectedHint")}</p>
        <ul class="usage-offline-list">
          <For each={props.accounts}>
            {(account) => (
              <li class="usage-offline-agent">
                <ProviderIcon id={harnessIcon(account.harness)} class="usage-account-icon" />
                <span class="usage-offline-name">{quotaAccountTitle(account)}</span>
                <Show when={account.usageError}>{(reason) => <span class="usage-offline-reason">{reason()}</span>}</Show>
              </li>
            )}
          </For>
        </ul>
      </Collapsible.Content>
    </Collapsible>
  )
}
