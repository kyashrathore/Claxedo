import { createMemo, createSignal, Match, Show, Switch, type JSX } from "solid-js"
import { useRunningCloudWorkspaces } from "@/cloud"
import { useErrorCopy, useTranslator } from "@/i18n"
import { useElapsed } from "@/lib/delay"
import { FailureNotice } from "@/lib/failure"
import { useMachineTime } from "../api"
import { usageDictionary } from "../i18n"
import type { UsageDays } from "../model"
import { listSandboxRows, sandboxRows, sandboxTotals, type SandboxFilter, type SandboxRowList } from "../sandbox-rows"
import { Choices, type Choice } from "./choices"
import { RANGES, rangeDays } from "./ranges"
import { SandboxPrices } from "./sandbox-prices"
import { SandboxTable } from "./sandbox-table"
import { SandboxTotalsSummary } from "./sandbox-totals"
import "./usage.css"

const FILTERS: readonly Choice<SandboxFilter>[] = [
  { value: "all", label: "usage.sandbox.filter.all" },
  { value: "running", label: "usage.sandbox.filter.running" },
]

const listedRows = (list: SandboxRowList) => (list.kind === "rows" ? list.rows : undefined)

export function SandboxUsageSection(): JSX.Element {
  const t = useTranslator(usageDictionary)
  const errorCopy = useErrorCopy("usage")
  const elapsed = useElapsed()
  const [days, setDays] = createSignal<UsageDays>(30)
  const [filter, setFilter] = createSignal<SandboxFilter>("all")
  const machineTime = useMachineTime(days)
  const running = useRunningCloudWorkspaces(() => true)
  const time = () => {
    const state = machineTime.load()
    return state.kind === "ready" ? state.data : undefined
  }
  const timeFailure = () => {
    const state = machineTime.load()
    return state.kind === "failed" ? state.error : undefined
  }
  const liveFailure = () => {
    const state = running.list()
    return state.kind === "failed" ? state.error : undefined
  }
  const live = () => {
    const state = running.list()
    return state.kind === "ready" ? state.rows : undefined
  }
  const rows = createMemo(() => sandboxRows(time(), live()))
  const totals = createMemo(() => sandboxTotals(rows()))
  const list = createMemo(() => listSandboxRows(rows(), filter(), { time: time() !== undefined, live: live() !== undefined }))
  const loaded = () => machineTime.load().kind !== "loading" || running.list().kind !== "loading"
  return (
    <div class="usage">
      <div class="usage-header">
        <Choices label={t("usage.range")} choices={RANGES} value={`${days()}` as const} onChange={(choice) => setDays(rangeDays(choice))} />
      </div>
      <Switch>
        <Match when={timeFailure()}>
          {(error) => <FailureNotice title={t("usage.sandbox.timeFailed")} message={errorCopy(error()).message} retryLabel={errorCopy(error()).retry} onRetry={machineTime.refresh} />}
        </Match>
        <Match when={time()}>
          <SandboxTotalsSummary totals={totals()} days={days()} />
        </Match>
        <Match when={elapsed()}>
          <p class="usage-status" role="status">{t("usage.sandbox.loading")}</p>
        </Match>
      </Switch>
      <Show when={liveFailure()}>
        {(error) => <FailureNotice title={t("usage.sandbox.failed")} message={errorCopy(error()).message} retryLabel={errorCopy(error()).retry} onRetry={running.refresh} />}
      </Show>
      <Show when={loaded()}>
        <section class="usage-sandbox-workspaces" aria-labelledby="usage-sandbox-workspaces-title">
          <div class="usage-header">
            <h3 id="usage-sandbox-workspaces-title" class="usage-group-title">{t("usage.sandbox.workspaces")}</h3>
            <Choices label={t("usage.sandbox.filter")} choices={FILTERS} value={filter()} onChange={setFilter} />
          </div>
          <Switch>
            <Match when={listedRows(list())}>{(shown) => <SandboxTable rows={shown()} onStop={(id) => void running.stop(id)} />}</Match>
            <Match when={list().kind === "empty"}>
              <p class="usage-empty">{t(filter() === "running" ? "usage.sandbox.noneRunning" : "usage.sandbox.empty")}</p>
            </Match>
          </Switch>
        </section>
      </Show>
      <Show when={time()}>{(ready) => <SandboxPrices time={ready()} />}</Show>
    </div>
  )
}
