import { Match, Show, Switch, type JSX } from "solid-js"
import { useErrorCopy, useTranslator } from "@/i18n"
import { useElapsed } from "@/lib/delay"
import { FailureNotice } from "@/lib/failure"
import { useMachineTime } from "../api"
import { usageDictionary } from "../i18n"
import { wholeMinutes } from "../model"
import { useUsageFormats } from "./usage-formats"

export function MachineTimeSummary(): JSX.Element {
  const t = useTranslator(usageDictionary)
  const format = useUsageFormats()
  const errorCopy = useErrorCopy("usage")
  const elapsed = useElapsed()
  const machineTime = useMachineTime()
  const failed = () => {
    const state = machineTime.load()
    return state.kind === "failed" ? state.error : undefined
  }
  const ready = () => {
    const state = machineTime.load()
    return state.kind === "ready" ? state.data : undefined
  }
  return (
    <section class="usage-machine-time" aria-labelledby="usage-machine-time-title">
      <h3 id="usage-machine-time-title" class="usage-group-title">{t("usage.machineTime.title")}</h3>
      <Switch>
        <Match when={failed()}>
          {(error) => <FailureNotice title={t("usage.machineTime.failed")} message={errorCopy(error()).message} retryLabel={errorCopy(error()).retry} onRetry={machineTime.refresh} />}
        </Match>
        <Match when={ready()}>
          {(time) => (
            <>
              <p class="usage-machine-time-value">{t("usage.machineTime.minutes", { minutes: format.whole(wholeMinutes(time().activeMs)) })}</p>
              <p class="usage-hint">{t("usage.machineTime.hint")}</p>
              <Show when={time().running > 0}>
                <p class="usage-hint">{t("usage.machineTime.running")}</p>
              </Show>
            </>
          )}
        </Match>
        <Match when={elapsed()}>
          <p class="usage-status" role="status">{t("usage.machineTime.loading")}</p>
        </Match>
      </Switch>
    </section>
  )
}
