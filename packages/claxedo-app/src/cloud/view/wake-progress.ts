import { createMemo, type Accessor } from "solid-js"
import { useI18n } from "@/i18n"
import { useSecondClock } from "@/lib/clock"
import { formatDuration } from "@/lib/duration"
import type { WorkspaceBootMode, WorkspaceRuntime, WorkspaceStartStep, WorkspaceStartSteps } from "@/server"
import { useCloudText, type CloudKey, type CloudText } from "../i18n"

type Waking = Extract<WorkspaceRuntime, { kind: "waking" }>

const SECOND_MS = 1_000

const FIRST_STEP: Readonly<Record<WorkspaceBootMode, CloudKey>> = {
  "cold-start": "cloud.wake.step.starting",
  resume: "cloud.wake.step.resuming",
  restore: "cloud.wake.step.restoring",
}

const NEXT_STEP: Readonly<Record<WorkspaceStartStep, CloudKey>> = {
  machine: "cloud.wake.step.image",
  image: "cloud.wake.step.runtime",
  runtime: "cloud.wake.step.connecting",
}

const DONE_STEP: Readonly<Record<WorkspaceStartStep, CloudKey>> = {
  machine: "cloud.wake.done.machine",
  image: "cloud.wake.done.image",
  runtime: "cloud.wake.done.runtime",
}

function currentStep(runtime: Waking): CloudKey {
  const last = runtime.steps?.done.at(-1)
  if (last === "machine" && runtime.bootMode !== undefined && runtime.bootMode !== "cold-start") return "cloud.wake.step.workspace"
  return last ? NEXT_STEP[last] : FIRST_STEP[runtime.bootMode ?? "cold-start"]
}

function since(at: number, now: number): string {
  return formatDuration(Math.max(0, now - at))
}

function totalPart(t: CloudText, steps: WorkspaceStartSteps, now: number): string | undefined {
  return steps.stepStartedAt - steps.startedAt >= SECOND_MS ? t("cloud.wake.total", { elapsed: since(steps.startedAt, now) }) : undefined
}

export function wakeProgressText(t: CloudText, runtime: Waking, now: number, list: (items: readonly string[]) => string): string {
  const steps = runtime.steps
  if (runtime.failure) {
    const retrying = t("cloud.wake.retrying", { reason: runtime.failure })
    return steps ? [retrying, t("cloud.wake.total", { elapsed: since(steps.startedAt, now) })].join(" · ") : retrying
  }
  if (!steps) return t(currentStep(runtime))
  const step = t("cloud.wake.stepFor", { step: t(currentStep(runtime)), elapsed: since(steps.stepStartedAt, now) })
  const done = steps.done.length ? t("cloud.wake.done", { steps: list(steps.done.map((item) => t(DONE_STEP[item]))) }) : undefined
  return [step, done, totalPart(t, steps, now)].filter((part) => part !== undefined).join(" · ")
}

export function useWakeProgress(runtime: Accessor<WorkspaceRuntime>): Accessor<string | undefined> {
  const t = useCloudText()
  const i18n = useI18n()
  const listFormat = createMemo(() => new Intl.ListFormat(i18n.intlTag(), { type: "conjunction" }))
  const timed = () => {
    const current = runtime()
    return current.kind === "waking" && current.steps !== undefined
  }
  const now = useSecondClock(timed)
  return () => {
    const current = runtime()
    if (current.kind !== "waking") return undefined
    return wakeProgressText(t, current, now(), (items) => listFormat().format(items))
  }
}
