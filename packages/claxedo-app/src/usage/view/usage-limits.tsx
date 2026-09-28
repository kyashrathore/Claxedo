import { createMemo, createUniqueId, For, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { FailureNotice } from "@/lib/failure"
import type { UsageSummary } from "@/server"
import { usageDictionary } from "../i18n"
import type { QuotaAccount } from "../model"
import { groupQuotaAccounts } from "../quota-groups"
import { NotConnectedAgents } from "./not-connected"
import { QuotaAccountCard } from "./quota-windows"

function AccountGroup(props: { readonly title: string; readonly accounts: readonly QuotaAccount[] }): JSX.Element {
  const titleId = createUniqueId()
  return (
    <Show when={props.accounts.length > 0}>
      <section class="usage-account-group" aria-labelledby={titleId}>
        <h3 id={titleId} class="usage-group-title">{props.title}</h3>
        <For each={props.accounts}>{(account) => <QuotaAccountCard account={account} />}</For>
      </section>
    </Show>
  )
}

export function UsageLimits(props: { readonly summary: UsageSummary; readonly onRefresh: () => void }): JSX.Element {
  const t = useTranslator(usageDictionary)
  const quota = () => props.summary.quota
  const groups = createMemo(() => groupQuotaAccounts(quota().snapshot?.accounts ?? []))
  const empty = () => quota().snapshot?.accounts.length === 0
  return (
    <section class="usage-limits" aria-label={t("usage.quota.title")}>
      <Show when={quota().refreshing}>
        <p class="usage-status" role="status">{t("usage.quota.checking")}</p>
      </Show>
      <Show when={quota().throttledUntil}>
        {(until) => <p class="usage-status" role="status">{t("usage.quota.throttled", { time: new Date(until()).toLocaleTimeString() })}</p>}
      </Show>
      <Show when={quota().error}>
        {(error) => <FailureNotice title={t("usage.quota.unavailable")} message={error()} retryLabel={t("usage.refresh")} onRetry={props.onRefresh} />}
      </Show>
      <Show when={!quota().snapshot && !quota().error}>
        <p class="usage-empty">{t("usage.quota.unavailable")}</p>
      </Show>
      <Show when={empty()}>
        <p class="usage-empty">{t("usage.quota.empty")}</p>
      </Show>
      <AccountGroup title={t("usage.quota.inUse")} accounts={groups().inUse} />
      <AccountGroup title={t("usage.quota.signedIn")} accounts={groups().signedIn} />
      <Show when={groups().notConnected.length > 0}>
        <NotConnectedAgents accounts={groups().notConnected} />
      </Show>
    </section>
  )
}
