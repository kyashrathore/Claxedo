import { createMemo, Match, Show, Switch, type JSX } from "solid-js"
import { useRunningCloudWorkspaces } from "@/cloud"
import { useErrorCopy, useTranslator } from "@/i18n"
import { useElapsed } from "@/lib/delay"
import { FailureNotice } from "@/lib/failure"
import { useMachineTime } from "../api"
import { cloudRows } from "../cloud-rows"
import { usageDictionary } from "../i18n"
import { CloudWorkspaceTable } from "./cloud-workspace-table"
import { MachineTimeSummary } from "./machine-time"

export function CloudUsage(): JSX.Element {
  const t = useTranslator(usageDictionary)
  const errorCopy = useErrorCopy("usage")
  const elapsed = useElapsed()
  const machineTime = useMachineTime()
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
  const rows = createMemo(() => cloudRows(time(), live()))
  const loaded = () => machineTime.load().kind !== "loading" || running.list().kind !== "loading"
  return (
    <section class="usage-cloud" aria-label={t("usage.view.cloud")}>
      <Switch>
        <Match when={timeFailure()}>
          {(error) => <FailureNotice title={t("usage.machineTime.failed")} message={errorCopy(error()).message} retryLabel={errorCopy(error()).retry} onRetry={machineTime.refresh} />}
        </Match>
        <Match when={time()}>{(ready) => <MachineTimeSummary time={ready()} />}</Match>
        <Match when={elapsed()}>
          <p class="usage-status" role="status">{t("usage.machineTime.loading")}</p>
        </Match>
      </Switch>
      <Show when={liveFailure()}>
        {(error) => <FailureNotice title={t("usage.cloud.failed")} message={errorCopy(error()).message} retryLabel={errorCopy(error()).retry} onRetry={running.refresh} />}
      </Show>
      <Show when={loaded()}>
        <div class="usage-cloud-workspaces">
          <h3 class="usage-group-title">{t("usage.cloud.title")}</h3>
          <p class="usage-hint">{t("usage.cloud.description")}</p>
          <Show when={rows().length > 0} fallback={<p class="usage-empty">{t("usage.cloud.empty")}</p>}>
            <CloudWorkspaceTable rows={rows()} onStop={(id) => void running.stop(id)} />
          </Show>
        </div>
      </Show>
    </section>
  )
}
