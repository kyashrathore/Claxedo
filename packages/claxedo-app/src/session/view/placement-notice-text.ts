import type { ComposerNotice } from "@/composer"
import { isFreshStart, type Placement, type WorkspaceRuntime } from "@/server"
import type { SessionScreenText } from "./text"

export type PlacementFacts = {
  readonly placement: Placement | undefined
  readonly name: string
  readonly runtime: WorkspaceRuntime
  readonly wakeProgress: string | undefined
  readonly retryTime?: string
  readonly offline: boolean
  readonly wake: () => void
}

export function placementNotice(t: SessionScreenText, facts: PlacementFacts): ComposerNotice | undefined {
  const name = facts.name
  const runtime = facts.runtime
  if (runtime.kind === "waking") {
    const message = t(isFreshStart(runtime) ? "sessionScreen.workspace.starting" : "sessionScreen.workspace.waking", { name })
    return { kind: "workspace-lifecycle", tone: "progress", message, ...(facts.wakeProgress ? { detail: facts.wakeProgress } : {}) }
  }
  if (runtime.kind === "wakeFailed") {
    const detail = runtime.retryAt !== undefined && facts.retryTime ? `${runtime.error.message} · ${t("sessionScreen.workspace.tryAgainAfter", { time: facts.retryTime })}` : runtime.error.message
    return { kind: "workspace-lifecycle", tone: "critical", message: t("sessionScreen.workspace.wakeFailed", { name }), detail, action: { label: t("sessionScreen.workspace.retryWake"), run: facts.wake } }
  }
  if (runtime.kind === "outdated") {
    return { kind: "workspace-lifecycle", tone: "warning", message: t("sessionScreen.workspace.outdated", { name }), detail: t("sessionScreen.workspace.outdated.detail"), action: { label: t("sessionScreen.workspace.restartToUpdate"), run: facts.wake } }
  }
  if (runtime.kind === "asleep") return { kind: "workspace-lifecycle", tone: "info", message: t("sessionScreen.workspace.asleep"), action: { label: t("sessionScreen.workspace.wakeNow"), run: facts.wake } }
  return facts.offline ? { kind: "machine-offline", tone: "warning", message: t("sessionScreen.workspace.machineOffline") } : undefined
}
