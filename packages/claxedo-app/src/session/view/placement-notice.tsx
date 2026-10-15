import { createEffect, type Accessor, type JSX } from "solid-js"
import { ComposerNoticeProvider, ComposerNoticeRow, createComposerNoticeChannel, publishComposerNotice, type ComposerNotice } from "@/composer"
import { useWakeProgress, useWorkspaceName } from "@/cloud"
import { isOfflineMachine, isStartingCloud, useServer, type PlacementId, type WorkspaceRuntime } from "@/server"
import { placementNotice } from "./placement-notice-text"
import { useSessionScreenText } from "./text"

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
