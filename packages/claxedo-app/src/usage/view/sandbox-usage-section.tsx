import { createMemo, createSignal, createUniqueId, Match, Show, Switch, type JSX } from "solid-js"
import { useRunningCloudWorkspaces } from "@/cloud"
import { useErrorCopy, useTranslator } from "@/i18n"
import { useElapsed } from "@/lib/delay"
import { FailureNotice } from "@/lib/failure"
import type { MachineTime } from "@/server"
import { useMachineTime } from "../api"
import { usageDictionary } from "../i18n"
import type { UsageDays } from "../model"
import { listSandboxGroups, sandboxProviderTotals, type SandboxFilter, type SandboxGroupList } from "../sandbox-groups"
import { sandboxRows, sandboxTotals } from "../sandbox-rows"
import { Choices, type Choice } from "./choices"
import { RANGES, rangeDays } from "./ranges"
import { SandboxPrices } from "./sandbox-prices"
import { SandboxProviderTable } from "./sandbox-provider-table"
import { SandboxTable } from "./sandbox-table"
import { SandboxTotalsSummary } from "./sandbox-totals"
import "./usage.css"

const FILTERS: readonly Choice<SandboxFilter>[] = [
  { value: "all", label: "usage.sandbox.filter.all" },
  { value: "running", label: "usage.sandbox.filter.running" },
]

const listedGroups = (list: SandboxGroupList) => (list.kind === "groups" ? list.groups : undefined)

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
  const list = createMemo(() => listSandboxGroups(rows(), filter(), { time: time() !== undefined, live: live() !== undefined }))
  const projectsTitle = createUniqueId()
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
      <Show when={time()}>{(ready) => <ProviderSection time={ready()} />}</Show>
      <Show when={loaded()}>
        <section class="usage-section" aria-labelledby={projectsTitle}>
          <div class="usage-section-head">
            <h3 id={projectsTitle} class="usage-section-title">{t("usage.sandbox.projects")}</h3>
            <Choices label={t("usage.sandbox.filter")} choices={FILTERS} value={filter()} onChange={setFilter} />
          </div>
          <Switch>
            <Match when={listedGroups(list())}>{(shown) => <SandboxTable groups={shown()} onStop={(id) => void running.stop(id)} />}</Match>
            <Match when={list().kind === "empty"}>
              <p class="usage-empty">{t(filter() === "running" ? "usage.sandbox.noneRunning" : "usage.sandbox.empty")}</p>
            </Match>
          </Switch>
        </section>
      </Show>
    </div>
  )
}

function ProviderSection(props: { readonly time: MachineTime }): JSX.Element {
  const t = useTranslator(usageDictionary)
  const titleId = createUniqueId()
  const totals = createMemo(() => sandboxProviderTotals(props.time))
  return (
    <Show when={totals().length > 0}>
      <section class="usage-section" aria-labelledby={titleId}>
        <div class="usage-section-head">
          <h3 id={titleId} class="usage-section-title">{t("usage.sandbox.providers")}</h3>
        </div>
        <SandboxProviderTable totals={totals()} />
        <SandboxPrices time={props.time} />
      </section>
    </Show>
  )
}
