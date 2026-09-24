import { createSignal, For, Match, Show, Switch, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { useElapsed } from "@/lib/delay"
import type { UsageSummary } from "@/server"
import { SegmentedControl, SegmentedControlItem } from "@/ui"
import { Button } from "@opencode-ai/ui/button"
import { useUsageSummary } from "../api"
import { dictionary, type UsageKey } from "../i18n"
import type { UsageDays, UsageGroup, UsageMetric, UsageOptions, UsageView } from "../model"
import { ClaxedoUsage } from "./claxedo-usage"
import { QuotaWindows } from "./quota-windows"

type Choice<Value extends string> = { readonly value: Value; readonly label: UsageKey }

const VIEWS: readonly Choice<UsageView>[] = [{ value: "quota", label: "usage.view.quota" }, { value: "claxedo", label: "usage.view.claxedo" }]
const RANGES: readonly Choice<"7" | "30">[] = [{ value: "7", label: "usage.range.7" }, { value: "30", label: "usage.range.30" }]
const METRICS: readonly Choice<UsageMetric>[] = [{ value: "tokens", label: "usage.metric.tokens" }, { value: "cost", label: "usage.metric.cost" }]
const GROUPS: readonly Choice<UsageGroup>[] = [{ value: "provider", label: "usage.group.provider" }, { value: "model", label: "usage.group.model" }]

function Choices<Value extends string>(props: { readonly label: string; readonly choices: readonly Choice<Value>[]; readonly value: Value; readonly onChange: (value: Value) => void }): JSX.Element {
  const t = useTranslator(dictionary)
  const pick = (value: string | null) => props.choices.find((choice) => choice.value === value)?.value
  return (
    <SegmentedControl aria-label={props.label} value={props.value} onChange={(value) => { const next = pick(value); if (next) props.onChange(next) }}>
      <For each={props.choices}>{(choice) => <SegmentedControlItem value={choice.value}>{t(choice.label)}</SegmentedControlItem>}</For>
    </SegmentedControl>
  )
}

function QuotaContent(props: { readonly summary: UsageSummary }): JSX.Element {
  const t = useTranslator(dictionary)
  const unavailable = () => (props.summary.quota.status === "available" ? undefined : (props.summary.quota.error ?? t("usage.quota.unavailable")))
  return (
    <>
      <Show when={props.summary.quota.refreshing}>
        <p class="usage-note" role="status">{t("usage.quota.checking")}</p>
      </Show>
      <Show when={unavailable()}>{(message) => <p class="usage-note" data-tone="danger" role="alert">{message()}</p>}</Show>
      <QuotaWindows accounts={props.summary.quota.snapshot?.accounts ?? []} />
    </>
  )
}

export function UsageSection(): JSX.Element {
  const t = useTranslator(dictionary)
  const [options, setOptions] = createSignal<UsageOptions>({ view: "quota", days: 7, metric: "tokens", group: "provider" })
  const [cursors, setCursors] = createSignal<readonly (string | undefined)[]>([])
  const usage = useUsageSummary(options)
  const elapsed = useElapsed()
  const choose = (patch: Partial<Omit<UsageOptions, "after">>) => {
    setCursors([])
    setOptions((current) => ({ view: current.view, days: current.days, metric: current.metric, group: current.group, ...patch }))
  }
  const paging = {
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
  const ready = () => {
    const load = usage.load()
    return load.kind === "ready" ? load.summary : undefined
  }
  return (
    <div class="usage" data-component="usage">
      <div class="usage-toolbar">
        <Choices label={t("usage.view")} choices={VIEWS} value={options().view} onChange={(view) => choose({ view })} />
        <Show when={options().view === "claxedo"}>
          <Choices label={t("usage.range")} choices={RANGES} value={options().days === 30 ? "30" : "7"} onChange={(days) => choose({ days: (days === "30" ? 30 : 7) satisfies UsageDays })} />
          <Choices label={t("usage.metric")} choices={METRICS} value={options().metric} onChange={(metric) => choose({ metric })} />
          <Choices label={t("usage.group")} choices={GROUPS} value={options().group} onChange={(group) => choose({ group })} />
        </Show>
        <Button size="small" variant="ghost" disabled={usage.fetching()} onClick={() => usage.refresh()}>{t("usage.refresh")}</Button>
      </div>
      <Switch>
        <Match when={usage.load().kind === "failed"}>
          <div class="usage-failure" role="alert">
            <p>{t("usage.failed")}</p>
            <Button size="small" variant="secondary" onClick={() => usage.refresh()}>{t("usage.retry")}</Button>
          </div>
        </Match>
        <Match when={ready()}>
          {(summary) => (
            <Show when={options().view === "claxedo"} fallback={<QuotaContent summary={summary()} />}>
              <ClaxedoUsage summary={summary()} group={options().group} metric={options().metric} paging={paging} />
            </Show>
          )}
        </Match>
        <Match when={elapsed()}>
          <p class="usage-note" role="status">{t("usage.loading")}</p>
        </Match>
      </Switch>
    </div>
  )
}
