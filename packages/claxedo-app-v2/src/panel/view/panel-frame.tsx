import { createEffect, createSignal, onCleanup, onMount, Show, type JSX, type ParentProps } from "solid-js"
import { useTranslator } from "@/i18n"
import { dictionary } from "../i18n"
import { usePanel } from "../store"
import { PANEL_CLOSE_GRACE_MS, PANEL_MOTION } from "../width"
import { PanelBody } from "./panel-body"
import { PanelHeader } from "./panel-header"
import { PanelResizeHandle } from "./resize-handle"

function WorkspacePanel(): JSX.Element {
  const t = useTranslator(dictionary)
  const panel = usePanel()
  const [dragging, setDragging] = createSignal(false)
  const [exposed, setExposed] = createSignal(panel.open())
  let aside: HTMLElement | undefined
  let hideTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    clearTimeout(hideTimer)
    if (panel.open()) {
      setExposed(true)
      return
    }
    hideTimer = setTimeout(() => setExposed(false), PANEL_CLOSE_GRACE_MS)
  })
  onCleanup(() => clearTimeout(hideTimer))
  onMount(() => {
    const parent = aside?.parentElement
    if (!parent) return
    const measure = () => panel.setAvailable(parent.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(parent)
    onCleanup(() => observer.disconnect())
  })
  return (
    <aside
      ref={aside}
      aria-label={exposed() ? t("panel.label") : undefined}
      aria-hidden={exposed() ? undefined : "true"}
      role={exposed() ? "complementary" : undefined}
      data-testid="workspace-panel-shell"
      data-open={panel.open() ? "true" : "false"}
      data-state-navigator={panel.navigator() ?? ""}
      class="absolute bottom-0 right-0 top-0 z-30 flex flex-col overflow-hidden bg-background-base will-change-[transform,opacity]"
      classList={{ "pointer-events-none": !panel.open() }}
      style={{
        width: panel.phone() ? "100%" : `${panel.width()}px`,
        "border-left": "1px solid var(--border-weaker-base)",
        contain: "strict",
        "backface-visibility": "hidden",
        transform: panel.open() ? "translate3d(0, 0, 0)" : "translate3d(100%, 0, 0)",
        transition: dragging() ? "none" : PANEL_MOTION,
        display: exposed() ? undefined : "none",
        visibility: exposed() ? "visible" : "hidden",
        "--workspace-panel-width": `${panel.width()}px`,
      }}
    >
      <Show when={panel.open() && !panel.phone() && !panel.fullWidth()}>
        <PanelResizeHandle onDragging={setDragging} />
      </Show>
      <div class="shrink-0">
        <PanelHeader />
      </div>
      <div class="relative min-h-0 flex-1">
        <Show when={exposed()}>
          <div data-testid="workspace-panel-body" class="absolute inset-0 overflow-auto">
            <PanelBody />
          </div>
        </Show>
      </div>
    </aside>
  )
}

export function WorkspaceArea(props: ParentProps): JSX.Element {
  const panel = usePanel()
  return (
    <div class="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <div
        data-testid="workbench-column"
        class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden transition-[margin-right] duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)] will-change-[margin-right]"
        style={{ "margin-right": `${panel.inset()}px` }}
      >
        {props.children}
      </div>
      <WorkspacePanel />
    </div>
  )
}
