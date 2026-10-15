import { createEffect, type Accessor, type JSX } from "solid-js"
import { ComposerNoticeProvider, ComposerNoticeRow, createComposerNoticeChannel, publishComposerNotice, type ComposerNotice } from "@/composer"
import { useWakeProgress, useWorkspaceName } from "@/cloud"
import { isOfflineMachine, isStartingCloud, useServer, type Placement, type PlacementId, type WorkspaceRuntime } from "@/server"
import { useSessionScreenText, type SessionScreenText } from "./text"

type PlacementFacts = {
  readonly placement: Placement | undefined
  readonly name: string
  readonly runtime: WorkspaceRuntime
  readonly wakeProgress: string | undefined
  readonly offline: boolean
  readonly wake: () => void
}

export function placementNotice(t: SessionScreenText, facts: PlacementFacts): ComposerNotice | undefined {
  const name = facts.name
  const runtime = facts.runtime
  if (runtime.kind === "waking") {
    return { kind: "workspace-lifecycle", tone: "progress", message: t("sessionScreen.workspace.waking", { name }), ...(facts.wakeProgress ? { detail: facts.wakeProgress } : {}) }
  }
  if (runtime.kind === "wakeFailed") {
    return { kind: "workspace-lifecycle", tone: "critical", message: t("sessionScreen.workspace.wakeFailed", { name }), detail: runtime.error.message, action: { label: t("sessionScreen.workspace.retryWake"), run: facts.wake } }
  }
  if (runtime.kind === "outdated") {
    return { kind: "workspace-lifecycle", tone: "warning", message: t("sessionScreen.workspace.outdated", { name }), detail: t("sessionScreen.workspace.outdated.detail"), action: { label: t("sessionScreen.workspace.restartToUpdate"), run: facts.wake } }
  }
  if (runtime.kind === "asleep") return { kind: "workspace-lifecycle", tone: "info", message: t("sessionScreen.workspace.asleep"), action: { label: t("sessionScreen.workspace.wakeNow"), run: facts.wake } }
  return facts.offline ? { kind: "machine-offline", tone: "warning", message: t("sessionScreen.workspace.machineOffline") } : undefined
}

export function usePlacementNotice(placementId: Accessor<PlacementId | undefined>): Accessor<ComposerNotice | undefined> {
  const t = useSessionScreenText()
  const server = useServer()
  const named = useWorkspaceName()
  const wake = (id: PlacementId) => () =>
    void server.cloud.start(id).catch((error: unknown) => console.warn("The workspace could not be woken", { placementId: id, error }))
  const runtime = (): WorkspaceRuntime => {
    const id = placementId()
    return id ? server.cloud.runtime(id) : { kind: "live" }
  }
  const wakeProgress = useWakeProgress(runtime)
  return () => {
    const id = placementId()
    if (!id) return undefined
    const placement = server.placements.byId(id)
    const name = placement ? named(placement.label, placement.branch) : ""
    return placementNotice(t, { placement, name, runtime: runtime(), wakeProgress: wakeProgress(), offline: isOfflineMachine(placement), wake: wake(id) })
  }
}

export function PlacementNotice(props: { readonly placementId: PlacementId }) {
  const server = useServer()
  createEffect(() => {
    if (isStartingCloud(server.placements.byId(props.placementId))) void server.cloud.follow(props.placementId)
  })
  publishComposerNotice(usePlacementNotice(() => props.placementId))
  return null
}

export function PlacementNoticeSlot(props: { readonly placementId: PlacementId; readonly children: JSX.Element }) {
  const channel = createComposerNoticeChannel()
  return (
    <ComposerNoticeProvider channel={channel}>
      <PlacementNotice placementId={props.placementId} />
      <ComposerNoticeRow notices={channel.notices()} />
      <div classList={{ "relative z-10 -mt-2": channel.notices().length > 0 }}>{props.children}</div>
    </ComposerNoticeProvider>
  )
}
