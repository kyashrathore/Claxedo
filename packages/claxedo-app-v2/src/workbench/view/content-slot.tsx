import { createMemo, onCleanup, Show, type Accessor, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useTranslator } from "@/i18n"
import { FailureBoundary } from "@/lib/failure"
import { dictionary } from "../i18n"
import type { createSurfaceKeyRouter, SurfaceKeySlot } from "../keyboard"
import { PaneContextProvider, type PaneContext } from "../pane-context"
import { useWorkbench } from "../provider"
import type { PaneRect } from "../types"
import { rectStyle } from "./geometry"

export function ContentSlot(props: {
  contentId: string
  paneOf: (contentId: string) => string | null
  displayed: (contentId: string) => boolean
  displayRects: Accessor<Map<string, PaneRect>>
  surfaceKeys: ReturnType<typeof createSurfaceKeyRouter>
}): JSX.Element {
  const wb = useWorkbench()
  const t = useTranslator(dictionary)
  const paneId = createMemo(() => props.paneOf(props.contentId))
  const visible = createMemo(() => props.displayed(props.contentId))
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
    const id = paneId()
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
  }
  const opened = createMemo(() => wb.content(props.contentId))

  return (
    <div
      ref={element}
      class="workbench-slot"
      data-workbench-content={props.contentId}
      data-pane-id={paneId() ?? undefined}
      data-stashed={paneId() ? undefined : "true"}
      data-inactive={inactive() ? "true" : undefined}
      aria-hidden={visible() ? undefined : "true"}
      inert={!visible()}
      style={style()}
      onMouseDown={() => pane.requestFocus()}
    >
      <PaneContextProvider value={pane}>
        <FailureBoundary title={t("workbench.failed")} retryLabel={t("workbench.retry")}>
          <Show when={opened()}>
            {(pane) => <Dynamic component={pane().kind.view} state={pane().state as never} paneId={paneId() ?? ""} active={focused()} />}
          </Show>
        </FailureBoundary>
      </PaneContextProvider>
    </div>
  )
}
