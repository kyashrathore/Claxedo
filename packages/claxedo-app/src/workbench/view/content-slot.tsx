import { createMemo, onCleanup, onMount, Show, type Accessor, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useTranslator } from "@/i18n"
import { FailureBoundary } from "@/lib/failure"
import { workbenchDictionary } from "../i18n"
import type { createSurfaceKeyRouter, SurfaceKeySlot } from "../keyboard"
import { PaneContextProvider, type PaneContext } from "../pane-context"
import { useWorkbench } from "../provider"
import type { PaneRect } from "../types"
import { rectStyle } from "./geometry"
import type { Presence } from "./handover"
import type { RevealHolds } from "./reveal-holds"

export function ContentSlot(props: {
  contentId: string
  paneOf: (contentId: string) => string | null
  presence: (contentId: string) => Presence
  heldBy: (contentId: string) => string | undefined
  holds: RevealHolds
  displayRects: Accessor<Map<string, PaneRect>>
  surfaceKeys: ReturnType<typeof createSurfaceKeyRouter>
}): JSX.Element {
  const wb = useWorkbench()
  const t = useTranslator(workbenchDictionary)
  const paneId = createMemo(() => props.paneOf(props.contentId))
  const presence = createMemo(() => props.presence(props.contentId))
  const visible = createMemo(() => presence() !== "hidden")
  const rectPane = () => paneId() ?? props.heldBy(props.contentId) ?? null
  const focused = createMemo(() => {
    const id = paneId()
    return id !== null && wb.layout().focusedPaneId === id
  })
  const inactive = createMemo(() => {
    const id = paneId()
    const focus = wb.layout().focusedPaneId
    return !!focus && !!id && focus !== id
  })
  const style = (): JSX.CSSProperties => {
    const id = rectPane()
    if (!id) return {}
    return rectStyle(props.displayRects().get(id))
  }
  let element: HTMLDivElement | undefined
  const slot: SurfaceKeySlot = { paneId, visible, keydown: new Set() }
  onCleanup(props.surfaceKeys.add(props.contentId, slot))
  const pane: PaneContext = {
    paneId,
    isFocused: focused,
    isVisible: visible,
    element: () => element,
    onKeyDown: (handler) => onCleanup(props.surfaceKeys.subscribe(slot, handler)),
    requestClose: (opts) => {
      const id = paneId()
      if (id) wb.split.close(id, opts ?? { destroyContent: false })
    },
    requestFocus: () => {
      const id = paneId()
      if (id) wb.split.focus(id)
    },
    holdReveal: (pending) => props.holds.hold(props.contentId, pending),
  }
  const opened = createMemo(() => wb.content(props.contentId))
  const mounted = () => visible() || opened()?.kind.keepMounted === true

  return (
    <div
      ref={element}
      class="workbench-slot"
      data-workbench-content={props.contentId}
      data-pane-id={paneId() ?? undefined}
      data-stashed={rectPane() ? undefined : "true"}
      data-presence={presence() === "incoming" || presence() === "outgoing" ? presence() : undefined}
      data-inactive={inactive() ? "true" : undefined}
      aria-hidden={visible() ? undefined : "true"}
      inert={presence() !== "shown"}
      style={style()}
      onMouseDown={() => pane.requestFocus()}
    >
      <PaneContextProvider value={pane}>
        <FailureBoundary title={t("workbench.failed")} retryLabel={t("workbench.retry")}>
          <Show when={mounted() ? opened() : undefined}>
            {(pane) => {
              onMount(() => onCleanup(props.holds.mounted(props.contentId)))
              return <Dynamic component={pane().kind.view} state={pane().state as never} paneId={paneId() ?? ""} active={focused()} />
            }}
          </Show>
        </FailureBoundary>
      </PaneContextProvider>
    </div>
  )
}
