import type { Accessor, JSX } from "solid-js"
import { ComposerNoticeProvider, ComposerNoticeRow, createComposerNoticeChannel, publishComposerNotice, type ComposerNotice } from "@/composer"
import { isOfflineMachine, useServer, type Placement, type PlacementId, type WorkspaceBootMode, type WorkspaceRuntime } from "@/server"
import { useSessionScreenText, type SessionScreenText } from "./text"

function bootDetail(t: SessionScreenText, bootMode: WorkspaceBootMode | undefined) {
  if (bootMode === "restore") return t("sessionScreen.workspace.restoring")
  if (bootMode === "resume") return t("sessionScreen.workspace.resuming")
  return t("sessionScreen.workspace.starting")
}

type PlacementFacts = { readonly placement: Placement | undefined; readonly runtime: WorkspaceRuntime; readonly offline: boolean; readonly wake: () => void }

export function placementNotice(t: SessionScreenText, facts: PlacementFacts): ComposerNotice | undefined {
  const name = facts.placement?.label ?? ""
  const runtime = facts.runtime
  if (runtime.kind === "waking") return { kind: "workspace-lifecycle", tone: "progress", message: t("sessionScreen.workspace.waking", { name }), detail: bootDetail(t, runtime.bootMode) }
  if (runtime.kind === "wakeFailed") {
    return { kind: "workspace-lifecycle", tone: "critical", message: t("sessionScreen.workspace.wakeFailed", { name }), detail: runtime.error.message, action: { label: t("sessionScreen.workspace.retryWake"), run: facts.wake } }
  }
  if (runtime.kind === "asleep") return { kind: "workspace-lifecycle", tone: "info", message: t("sessionScreen.workspace.asleep"), action: { label: t("sessionScreen.workspace.wakeNow"), run: facts.wake } }
  return facts.offline ? { kind: "machine-offline", tone: "warning", message: t("sessionScreen.workspace.machineOffline") } : undefined
}

export function usePlacementNotice(placementId: Accessor<PlacementId | undefined>): Accessor<ComposerNotice | undefined> {
  const t = useSessionScreenText()
  const server = useServer()
  const wake = (id: PlacementId) => () =>
    void server.cloud.start(id).catch((error: unknown) => console.warn("The workspace could not be woken", { placementId: id, error }))
  return () => {
    const id = placementId()
    if (!id) return undefined
    const placement = server.placements.byId(id)
    return placementNotice(t, { placement, runtime: server.cloud.runtime(id), offline: isOfflineMachine(placement, server.capabilities()?.thisMachine?.id), wake: wake(id) })
  }
}

export function PlacementNotice(props: { readonly placementId: PlacementId }) {
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
