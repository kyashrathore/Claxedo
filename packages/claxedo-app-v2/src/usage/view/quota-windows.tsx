import { For, Show, type JSX } from "solid-js"
import { useI18n, useTranslator } from "@/i18n"
import { formatRelativeTime } from "@/lib/relative-time"
import { ProviderIcon } from "@/ui"
import { dictionary, type UsageKey } from "../i18n"
import { usedPercent, type QuotaAccount, type QuotaWindow } from "../model"
import "./usage.css"

const WINDOW_KEY: Readonly<Record<string, UsageKey>> = {
  session: "usage.window.session",
  weekly: "usage.window.weekly",
  weekly_opus: "usage.window.weeklyOpus",
}

const HARNESS_ICON: Readonly<Record<string, string>> = { claude: "anthropic", codex: "openai", cursor: "cursor" }

export function useWindowName(): (window: QuotaWindow) => string {
  const t = useTranslator(dictionary)
  return (window) => {
    const key = WINDOW_KEY[window.window]
    return key ? t(key) : window.window.replaceAll("_", " ")
  }
}

export function QuotaWindowMeter(props: { readonly account: string; readonly window: QuotaWindow }): JSX.Element {
  const t = useTranslator(dictionary)
  const i18n = useI18n()
  const windowName = useWindowName()
  const percent = () => usedPercent(props.window)
  return (
    <div class="usage-meter">
      <div class="usage-meter-label">
        <span>{windowName(props.window)}</span>
        <span>{t("usage.quota.windowLeft", { percent: 100 - percent() })}</span>
      </div>
      <progress
        class="usage-meter-bar"
        max={100}
        value={percent()}
        aria-label={t("usage.quota.windowUsed", { account: props.account, window: windowName(props.window), percent: percent() })}
      />
      <Show when={props.window.resetsAt}>
        {(resetsAt) => <span class="usage-meter-reset">{t("usage.quota.windowResets", { reset: formatRelativeTime(resetsAt(), i18n.intlTag()) })}</span>}
      </Show>
    </div>
  )
}

function accountLabel(account: QuotaAccount): string {
  return account.label ?? account.harness
}

export function QuotaWindows(props: { readonly accounts: readonly QuotaAccount[] }): JSX.Element {
  const t = useTranslator(dictionary)
  return (
    <section class="usage-quota" aria-label={t("usage.quota.title")}>
      <Show when={props.accounts.length > 0} fallback={<p class="usage-note">{t("usage.quota.empty")}</p>}>
        <For each={props.accounts}>
          {(account) => (
            <article class="usage-card" aria-label={accountLabel(account)}>
              <header class="usage-card-head">
                <ProviderIcon id={HARNESS_ICON[account.harness] ?? account.harness} />
                <span class="usage-card-title">{accountLabel(account)}</span>
                <Show when={account.plan}>{(plan) => <span class="usage-card-meta">{plan()}</span>}</Show>
                <Show when={account.inUse}>
                  <span class="usage-card-badge">{t("usage.quota.inUse")}</span>
                </Show>
              </header>
              <Show when={account.usageError}>{(error) => <p class="usage-note" data-tone="danger">{error()}</p>}</Show>
              <For each={account.windows}>{(window) => <QuotaWindowMeter account={accountLabel(account)} window={window} />}</For>
            </article>
          )}
        </For>
      </Show>
    </section>
  )
}
