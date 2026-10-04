import { createSignal, Match, Show, Switch, type JSX } from "solid-js"
import { useErrorCopy, useTranslator } from "@/i18n"
import { useElapsed } from "@/lib/delay"
import { FailureNotice } from "@/lib/failure"
import { useServer } from "@/server"
import { ClaxedoIconButton } from "@/ui"
import { useUsageSummary } from "../api"
import { usageDictionary } from "../i18n"
import type { UsageDays, UsageMetric, UsageOptions, UsageTab } from "../model"
import type { BreakdownPaging } from "./breakdown"
import { Choices, type Choice } from "./choices"
import { ClaxedoUsage } from "./claxedo-usage"
import { CloudUsage } from "./cloud-usage"
import { UsageLimits } from "./usage-limits"
import "./usage.css"

const QUOTA: Choice<UsageTab> = { value: "quota", label: "usage.view.quota" }
const CLAXEDO: Choice<UsageTab> = { value: "claxedo", label: "usage.view.claxedo" }
const CLOUD: Choice<UsageTab> = { value: "cloud", label: "usage.view.cloud" }

function useUsageTabs() {
  const server = useServer()
  return () => {
    const capabilities = server.capabilities()
    return [...(capabilities?.thisMachine ? [QUOTA] : []), CLAXEDO, ...(capabilities?.features.cloud ? [CLOUD] : [])]
  }
}
const RANGES: readonly Choice<"7" | "30" | "90">[] = [
  { value: "7", label: "usage.range.7" },
  { value: "30", label: "usage.range.30" },
  { value: "90", label: "usage.range.90" },
]
const DAYS: Readonly<Record<"7" | "30" | "90", UsageDays>> = { "7": 7, "30": 30, "90": 90 }
const METRICS: readonly Choice<UsageMetric>[] = [
  { value: "tokens", label: "usage.metric.tokens" },
  { value: "cost", label: "usage.metric.cost" },
]

export function UsageSection(): JSX.Element {
  const t = useTranslator(usageDictionary)
  const tabs = useUsageTabs()
  const [tab, setTab] = createSignal<UsageTab>(tabs()[0]?.value ?? "claxedo")
  const [options, setOptions] = createSignal<UsageOptions>({ view: tab() === "quota" ? "quota" : "claxedo", days: 7, metric: "tokens", group: "provider" })
  const [cursors, setCursors] = createSignal<readonly (string | undefined)[]>([])
  const usage = useUsageSummary(options, () => tab() !== "cloud")
  const elapsed = useElapsed()
  const errorCopy = useErrorCopy()
  const refresh = () => setOptions((current) => ({ ...current, refreshNonce: Date.now() }))
  const pickTab = (next: UsageTab) => {
    setTab(next)
    if (next !== "cloud") choose({ view: next })
  }
  const choose = (patch: Partial<Omit<UsageOptions, "after">>) => {
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
  const failed = () => {
    const load = usage.load()
    return load.kind === "failed" ? load.error : undefined
  }
  const ready = () => {
    const load = usage.load()
    return load.kind === "ready" ? load.summary : undefined
  }
  return (
    <div class="usage">
      <div class="usage-header">
        <Choices label={t("usage.view")} choices={tabs()} value={tab()} onChange={pickTab} />
        <Show when={tab() !== "cloud"}>
          <ClaxedoIconButton
          icon="reload"
          variant="ghost"
          class="usage-refresh"
          aria-label={t("usage.refresh")}
          title={t("usage.refresh")}
          disabled={usage.fetching()}
          onClick={refresh}
          />
        </Show>
      </div>
      <Show when={tab() === "claxedo"}>
        <div class="usage-controls">
          <Choices label={t("usage.range")} choices={RANGES} value={`${options().days}` as const} onChange={(days) => choose({ days: DAYS[days] })} />
          <Choices label={t("usage.metric")} choices={METRICS} value={options().metric} onChange={(metric) => choose({ metric })} />
        </div>
      </Show>
      <Switch>
        <Match when={tab() === "cloud"}>
          <CloudUsage />
        </Match>
        <Match when={failed()}>
          {(error) => <FailureNotice title={t("usage.failed")} message={errorCopy(error()).message} retryLabel={errorCopy(error()).retry} onRetry={() => usage.refresh()} />}
        </Match>
        <Match when={ready()}>
          {(summary) => (
            <Show when={options().view === "claxedo"} fallback={<UsageLimits summary={summary()} onRefresh={refresh} />}>
              <ClaxedoUsage summary={summary()} group={options().group} metric={options().metric} paging={paging} onGroup={(group) => choose({ group })} onRefresh={refresh} />
            </Show>
          )}
        </Match>
        <Match when={elapsed()}>
          <p class="usage-status" role="status">{t("usage.loading")}</p>
        </Match>
      </Switch>
    </div>
  )
}
