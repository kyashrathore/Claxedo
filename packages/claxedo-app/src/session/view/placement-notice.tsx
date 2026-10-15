import { createEffect, createMemo, type Accessor, type JSX } from "solid-js"
import { useI18n } from "@/i18n"
import { ComposerNoticeProvider, ComposerNoticeRow, createComposerNoticeChannel, publishComposerNotice, useSelectedHarness, type ComposerKey, type ComposerNotice } from "@/composer"
import { useWakeProgress, useWakeWorkspace, useWorkspaceName } from "@/cloud"
import { runsInSessionHost } from "@/lib/harness-selection"
import { isOfflineMachine, isStartingCloud, useServer, type PlacementId, type WorkspaceRuntime } from "@/server"
import { placementNotice } from "./placement-notice-text"
import { useSessionScreenText } from "./text"

export function usePlacementNotice(placementId: Accessor<PlacementId | undefined>, composerKey: Accessor<ComposerKey>): Accessor<ComposerNotice | undefined> {
  const t = useSessionScreenText()
  const server = useServer()
  const named = useWorkspaceName()
  const wakeWorkspace = useWakeWorkspace()
  const harness = useSelectedHarness(composerKey)
  const runtime = (): WorkspaceRuntime => {
    const id = placementId()
    return id ? server.cloud.runtime(id) : { kind: "live" }
  }
  const wakeProgress = useWakeProgress(runtime)
  const i18n = useI18n()
  const timeFormat = createMemo(() => new Intl.DateTimeFormat(i18n.intlTag(), { hour: "numeric", minute: "2-digit" }))
  const retryTime = () => {
    const current = runtime()
    return current.kind === "wakeFailed" && current.retryAt !== undefined ? timeFormat().format(current.retryAt) : undefined
  }
  return () => {
    const id = placementId()
    if (!id) return undefined
    const placement = server.placements.byId(id)
    const name = placement ? named(placement.label, placement.branch) : ""
    const time = retryTime()
    return placementNotice(t, {
      placement,
      name,
      runtime: runtime(),
      wakeProgress: wakeProgress(),
      ...(time ? { retryTime: time } : {}),
      offline: isOfflineMachine(placement),
      harnessRunsInSessionHost: runsInSessionHost(harness()),
      wake: () => wakeWorkspace(id),
    })
  }
}

export function PlacementNotice(props: { readonly placementId: PlacementId; readonly composerKey: ComposerKey }) {
  const server = useServer()
  createEffect(() => {
    if (isStartingCloud(server.placements.byId(props.placementId))) void server.cloud.follow(props.placementId)
  })
  publishComposerNotice(usePlacementNotice(() => props.placementId, () => props.composerKey))
  return null
}

export function PlacementNoticeSlot(props: { readonly placementId: PlacementId; readonly composerKey: ComposerKey; readonly children: JSX.Element }) {
  const channel = createComposerNoticeChannel()
  return (
    <ComposerNoticeProvider channel={channel}>
      <PlacementNotice placementId={props.placementId} composerKey={props.composerKey} />
      <ComposerNoticeRow notices={channel.notices()} />
      <div classList={{ "relative z-10 -mt-2": channel.notices().length > 0 }}>{props.children}</div>
    </ComposerNoticeProvider>
  )
}
