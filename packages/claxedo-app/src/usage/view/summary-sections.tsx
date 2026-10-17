import { createSignal, Match, Show, Switch, type Accessor, type JSX } from "solid-js"
import { useErrorCopy, useTranslator } from "@/i18n"
import { useElapsed } from "@/lib/delay"
import { FailureNotice } from "@/lib/failure"
import { useServer, type UsageSummary } from "@/server"
import { ClaxedoIconButton } from "@/ui"
import { useUsageSummary, type UsageSummaryRead } from "../api"
import { usageDictionary } from "../i18n"
import type { UsageMetric, UsageOptions, UsageView } from "../model"
import { AccountSpendSection } from "./account-spend-section"
import type { BreakdownPaging } from "./breakdown"
import { Choices, type Choice } from "./choices"
import { ClaxedoUsage } from "./claxedo-usage"
import { RANGES, rangeDays } from "./ranges"
import { UsageLimits } from "./usage-limits"
import "./usage.css"

const METRICS: readonly Choice<UsageMetric>[] = [
  { value: "tokens", label: "usage.metric.tokens" },
  { value: "cost", label: "usage.metric.cost" },
]

function useSummaryOptions(view: UsageView) {
  const [options, setOptions] = createSignal<UsageOptions>({ view, days: 7, metric: "tokens", group: "provider" })
  const [cursors, setCursors] = createSignal<readonly (string | undefined)[]>([])
  const usage = useUsageSummary(options, () => true)
  const refresh = () => setOptions((current) => ({ ...current, refreshNonce: Date.now() }))
  const choose = (patch: Partial<Pick<UsageOptions, "days" | "metric" | "group">>) => {
    setCursors([])
    setOptions((current) => ({ view: current.view, days: current.days, metric: current.metric, group: current.group, ...patch }))
  }
  const paging: BreakdownPaging = {
    get hasPrevious() {
      return cursors().length > 0
    },
    previous: () => {
      const stack = cursors()
      setCursors(stack.slice(0, -1))
      setOptions((current) => ({ ...current, after: stack.at(-1) }))
    },
    next: (cursor: string) => {
      setCursors([...cursors(), options().after])
      setOptions((current) => ({ ...current, after: cursor }))
    },
  }
  return { options, usage, refresh, choose, paging }
}

function RefreshButton(props: { readonly usage: UsageSummaryRead; readonly onRefresh: () => void }): JSX.Element {
  const t = useTranslator(usageDictionary)
  return (
    <ClaxedoIconButton
      icon="reload"
      variant="ghost"
      class="usage-refresh"
      aria-label={t("usage.refresh")}
      title={t("usage.refresh")}
      disabled={props.usage.fetching()}
      onClick={props.onRefresh}
    />
  )
}

function SummaryLoad(props: { readonly usage: UsageSummaryRead; readonly children: (summary: Accessor<UsageSummary>) => JSX.Element }): JSX.Element {
  const t = useTranslator(usageDictionary)
  const elapsed = useElapsed()
  const errorCopy = useErrorCopy("usage")
  const failed = () => {
    const load = props.usage.load()
    return load.kind === "failed" ? load.error : undefined
  }
  const ready = () => {
    const load = props.usage.load()
    return load.kind === "ready" ? load.data : undefined
  }
  return (
    <Switch>
      <Match when={failed()}>
        {(error) => <FailureNotice title={t("usage.failed")} message={errorCopy(error()).message} retryLabel={errorCopy(error()).retry} onRetry={() => props.usage.refresh()} />}
      </Match>
      <Match when={ready()}>{(summary) => props.children(summary)}</Match>
      <Match when={elapsed()}>
        <p class="usage-status" role="status">{t("usage.loading")}</p>
      </Match>
    </Switch>
  )
}

export function UsageLimitsSection(): JSX.Element {
  const summary = useSummaryOptions("quota")
  return (
    <div class="usage">
      <div class="usage-header">
        <RefreshButton usage={summary.usage} onRefresh={summary.refresh} />
      </div>
      <SummaryLoad usage={summary.usage}>{(ready) => <UsageLimits summary={ready()} onRefresh={summary.refresh} />}</SummaryLoad>
    </div>
  )
}

export function AiUsageSection(): JSX.Element {
  const t = useTranslator(usageDictionary)
  const server = useServer()
  const summary = useSummaryOptions("claxedo")
  const options = summary.options
  return (
    <div class="usage">
      <div class="usage-header">
        <RefreshButton usage={summary.usage} onRefresh={summary.refresh} />
      </div>
      <div class="usage-controls">
        <Choices label={t("usage.range")} choices={RANGES} value={`${options().days}` as const} onChange={(days) => summary.choose({ days: rangeDays(days) })} />
        <Choices label={t("usage.metric")} choices={METRICS} value={options().metric} onChange={(metric) => summary.choose({ metric })} />
      </div>
      <SummaryLoad usage={summary.usage}>
        {(ready) => (
          <ClaxedoUsage
            summary={ready()}
            group={options().group}
            metric={options().metric}
            paging={summary.paging}
            onGroup={(group) => summary.choose({ group })}
            onRefresh={summary.refresh}
          />
        )}
      </SummaryLoad>
      <Show when={server.capabilities()?.features.cloud === true}>
        <AccountSpendSection days={options().days} />
      </Show>
    </div>
  )
}
