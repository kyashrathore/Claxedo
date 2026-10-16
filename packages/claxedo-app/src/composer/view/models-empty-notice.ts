import type { StartFreshAction } from "@/cloud"
import type { WorkspaceRuntime } from "@/server"
import type { ComposerText } from "../text"
import type { HarnessAccountState } from "./harness-account-state"
import type { ModelLoadFailure } from "./harness-picker-model-section"

export type ModelsEmptyFacts = {
  readonly harnessName: string
  readonly workspaceName: string
  readonly runtime: WorkspaceRuntime
  readonly wakeProgress: string | undefined
  readonly account: HarnessAccountState
  readonly unavailableHere: ModelLoadFailure | undefined
  readonly wake: () => void
  readonly startFresh: StartFreshAction
  readonly openProviders: () => void
}

function machineNotice(t: ComposerText, facts: ModelsEmptyFacts): ModelLoadFailure | undefined {
  const name = facts.workspaceName
  const runtime = facts.runtime
  if (runtime.kind === "waking") return { message: t("composer.models.waking", { name }), detail: facts.wakeProgress ?? t("composer.models.waking.detail") }
  if (runtime.kind === "wakeFailed") {
    const action = runtime.checkpointUnusable ? facts.startFresh : { label: t("composer.models.retryWake"), run: facts.wake }
    return { message: t("composer.models.wakeFailed", { name }), detail: runtime.error.message, action }
  }
  if (runtime.kind === "asleep") return { message: t("composer.models.asleep", { name }), detail: t("composer.models.asleep.detail"), action: { label: t("composer.models.wakeNow"), run: facts.wake } }
  return undefined
}

export function modelsEmptyNotice(t: ComposerText, facts: ModelsEmptyFacts): ModelLoadFailure | undefined {
  if (facts.unavailableHere) return facts.unavailableHere
  const machine = machineNotice(t, facts)
  if (machine) return machine
  const harness = facts.harnessName
  if (facts.account === "missing") {
    return { message: t("composer.models.none"), detail: t("composer.models.none.detail", { harness }), action: { label: t("composer.models.addAccount"), run: facts.openProviders } }
  }
  if (facts.account === "refused") {
    return { message: t("composer.models.refused", { harness }), detail: t("composer.models.refused.detail"), action: { label: t("composer.models.reconnect"), run: facts.openProviders } }
  }
  return facts.account === "present" ? { message: t("composer.models.empty", { harness }) } : undefined
}
