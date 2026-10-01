import { type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { emitTerminalFit } from "@/lib/terminal-fit"
import { ResizeSeparator, type ResizeGrowth } from "@/ui"
import { panelDictionary } from "../i18n"
import { usePanel } from "../store"
import { NAVIGATOR_MIN_WIDTH } from "../width"

export function createWorkspaceResize(onDragging: (dragging: boolean) => void) {
  let previousSuspended: string | undefined
  let active = false
  return {
    resize: (choose: () => void) => {
      choose()
      if (!active) emitTerminalFit()
    },
    dragging: (dragging: boolean) => {
      active = dragging
      if (dragging) {
        previousSuspended = document.documentElement.dataset.terminalResizeSuspended
        document.documentElement.dataset.terminalResizeSuspended = "1"
      } else {
        if (previousSuspended === undefined) delete document.documentElement.dataset.terminalResizeSuspended
        else document.documentElement.dataset.terminalResizeSuspended = previousSuspended
        emitTerminalFit()
      }
      onDragging(dragging)
    },
  }
}

export function NavigatorResizeHandle(props: {
  readonly side: ResizeGrowth
  readonly onDragging: (dragging: boolean) => void
}): JSX.Element {
  const t = useTranslator(panelDictionary)
  const panel = usePanel()
  const policy = createWorkspaceResize(props.onDragging)
  return (
    <ResizeSeparator
      label={t("panel.navigator.resize")}
      value={panel.navigatorWidth()}
      min={NAVIGATOR_MIN_WIDTH}
      max={panel.navigatorMaxWidth()}
      grows={props.side === "left" ? "right" : "left"}
      class="-left-1 w-2 after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:transition-colors hover:after:bg-border-base focus-visible:after:bg-border-interactive-base active:after:bg-border-base"
      onResize={(width) => policy.resize(() => panel.chooseNavigatorWidth(width))}
      onDragging={policy.dragging}
    />
  )
}
