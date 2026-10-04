import { createUniqueId, For, Show, type JSX } from "solid-js"
import { useI18n, useTranslator } from "@/i18n"
import { harnessDisplayLabel, harnessIcon } from "@/lib/harness-catalog"
import { formatRelativeTime } from "@/lib/relative-time"
import { ClaxedoIcon, ProviderIcon } from "@/ui"
import { usageDictionary, type UsageKey } from "../i18n"
import { usedPercent, type QuotaAccount, type QuotaWindow } from "../model"
import { windowRisk } from "../quota-groups"
import "./limits.css"

const WINDOW_KEY: Readonly<Record<string, UsageKey>> = {
  session: "usage.window.session",
  weekly: "usage.window.weekly",
  weekly_opus: "usage.window.weeklyOpus",
  credits: "usage.window.credits",
  spark_session: "usage.window.sparkSession",
  spark_weekly: "usage.window.sparkWeekly",
  plan: "usage.window.plan",
  auto: "usage.window.auto",
  api: "usage.window.api",
}

export function useWindowName(): (window: QuotaWindow) => string {
  const t = useTranslator(usageDictionary)
  return (window) => {
    const key = WINDOW_KEY[window.window]
    return key ? t(key) : window.window.replaceAll("_", " ")
  }
}

export function quotaAccountTitle(account: QuotaAccount): string {
  return account.otherAgent ? (account.label ?? harnessDisplayLabel(account.harness)) : harnessDisplayLabel(account.harness)
}

function accountDetail(account: QuotaAccount): string | undefined {
  return account.otherAgent ? undefined : account.label
}

function QuotaWindowMeter(props: { readonly account: string; readonly window: QuotaWindow }): JSX.Element {
  const t = useTranslator(usageDictionary)
  const i18n = useI18n()
  const windowName = useWindowName()
  const percent = () => usedPercent(props.window)
  const risk = () => windowRisk(props.window)
  return (
    <div class="usage-window" data-risk={risk()}>
      <span class="usage-window-name">{windowName(props.window)}</span>
      <progress
        class="usage-window-bar"
        max={100}
        value={percent()}
        aria-label={t("usage.quota.windowUsed", { account: props.account, window: windowName(props.window), percent: percent() })}
      />
      <span class="usage-window-value">{risk() === "reached" ? t("usage.quota.windowReached") : t("usage.quota.windowPercent", { percent: percent() })}</span>
      <span class="usage-window-reset">
        <Show when={props.window.resetsAt}>{(resetsAt) => t("usage.quota.windowResets", { reset: formatRelativeTime(resetsAt(), i18n.intlTag()) })}</Show>
      </span>
    </div>
  )
}

export function QuotaAccountCard(props: { readonly account: QuotaAccount }): JSX.Element {
  const t = useTranslator(usageDictionary)
  const i18n = useI18n()
  const titleId = createUniqueId()
  const spoken = () => [quotaAccountTitle(props.account), accountDetail(props.account)].filter(Boolean).join(" ")
  return (
    <article class="usage-account" aria-labelledby={titleId}>
      <header class="usage-account-head">
        <ProviderIcon id={harnessIcon(props.account.harness)} class="usage-account-icon" />
        <div id={titleId} class="usage-account-title">
          <span class="usage-account-name">
            {quotaAccountTitle(props.account)}
            <Show when={props.account.plan}>{(plan) => <span class="usage-account-plan">{plan()}</span>}</Show>
          </span>
          <Show when={accountDetail(props.account)}>{(detail) => <span class="usage-account-detail">{detail()}</span>}</Show>
        </div>
        <Show when={props.account.usageAt}>
          {(at) => <span class="usage-account-updated">{t("usage.quota.updated", { time: formatRelativeTime(at(), i18n.intlTag()) })}</span>}
        </Show>
      </header>
      <Show when={props.account.usageError}>
        {(error) => (
          <p class="usage-account-note">
            <ClaxedoIcon name="circle-alert" size="small" class="usage-account-note-icon" />
            <span>{error()}</span>
          </p>
        )}
      </Show>
      <Show when={props.account.windows.length > 0}>
        <div class="usage-windows">
          <For each={props.account.windows}>{(window) => <QuotaWindowMeter account={spoken()} window={window} />}</For>
        </div>
      </Show>
    </article>
  )
}
