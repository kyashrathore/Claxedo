import {
  createContext,
  createMemo,
  createSignal,
  useContext,
  type Accessor,
  type JSX,
  type ParentProps,
} from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { useActiveSession } from "@/files"
import { persistedSignal, preferenceKey } from "@/lib/persisted"
import type { PlacementId } from "@/server"
import { useShellLayout, useShellRoute } from "@/shell"
import { closeReviewWorkspaceTab } from "./close"
import type { FileReveal, PanelFocus, ReviewFocus } from "./focus"
import { createPanelTabs } from "./tabs-store"
import { clampPanelWidth, PANEL_PHONE_MAX_WIDTH, restingPanelWidth, workbenchInset } from "./width"
import type { ReviewWorkspaceTab, WorkspacePanelNavigator } from "./workspace-tabs"

export type Panel = {
  readonly placementId: Accessor<PlacementId | undefined>
  readonly sessionId: Accessor<string>
  readonly open: Accessor<boolean>
  readonly phone: Accessor<boolean>
  readonly tabs: Accessor<readonly ReviewWorkspaceTab[]>
  readonly activeTab: Accessor<ReviewWorkspaceTab>
  readonly navigator: Accessor<WorkspacePanelNavigator | null>
  readonly fullWidth: Accessor<boolean>
  readonly width: Accessor<number>
  readonly available: Accessor<number>
  readonly inset: Accessor<number>
  readonly setAvailable: (width: number) => void
  readonly chooseWidth: (width: number) => void
  readonly toggleFullWidth: () => void
  readonly toggle: () => void
  readonly close: () => void
  readonly show: (focus?: PanelFocus) => void
  readonly activate: (tabId: string) => void
  readonly closeTab: (tabId: string) => void
  readonly toggleNavigator: (navigator: WorkspacePanelNavigator) => void
  readonly fileReveal: Accessor<FileReveal | undefined>
  readonly reviewFocus: Accessor<ReviewFocus | undefined>
}

type PanelSize = Pick<
  Panel,
  "phone" | "fullWidth" | "width" | "available" | "setAvailable" | "chooseWidth" | "toggleFullWidth"
>

const PanelContext = createContext<Panel>()

function readWidth(value: unknown): number | null | undefined {
  if (value === null) return null
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function createPanelSize(): PanelSize {
  const phone = createMediaQuery(`(max-width: ${PANEL_PHONE_MAX_WIDTH}px)`)
  const [chosen, setChosen] = persistedSignal<number | null>(preferenceKey("panel", "width"), null, readWidth)
  const [fullWidth, setFullWidth] = createSignal(false)
  const [available, setAvailable] = createSignal(typeof window === "undefined" ? 1024 : window.innerWidth)
  const width = createMemo(() =>
    restingPanelWidth({ available: available(), phone: phone(), fullWidth: fullWidth(), chosen: chosen() }),
  )
  return {
    phone,
    fullWidth,
    width,
    available,
    setAvailable: (value) => setAvailable(value),
    chooseWidth: (value) => setChosen(Math.round(clampPanelWidth(value, available()))),
    toggleFullWidth: () => setFullWidth((value) => !value),
  }
}

export function PanelProvider(props: ParentProps): JSX.Element {
  const layout = useShellLayout()
  const placementId = useShellRoute().placementId
  const session = useActiveSession()
  const sessionId = () => session()?.sessionId ?? ""
  const tabs = createPanelTabs(placementId, sessionId)
  const size = createPanelSize()
  const close = () => layout.send({ type: "hidePanel" })
  const panel: Panel = {
    ...size,
    ...tabs,
    placementId,
    sessionId,
    open: layout.panelShown,
    inset: () =>
      workbenchInset({
        open: layout.panelShown(),
        phone: size.phone(),
        fullWidth: size.fullWidth(),
        width: size.width(),
      }),
    toggle: () => layout.send({ type: "togglePanel" }),
    close,
    show: (focus) => {
      if (focus) tabs.focus(focus)
      layout.send({ type: "showPanel" })
    },
    closeTab: (tabId) => closeReviewWorkspaceTab({ id: tabId, closePanel: close, closeTab: tabs.closeTab }),
  }
  return <PanelContext.Provider value={panel}>{props.children}</PanelContext.Provider>
}

export function usePanel(): Panel {
  const panel = useContext(PanelContext)
  if (!panel) throw new Error("usePanel needs a PanelProvider above it")
  return panel
}
