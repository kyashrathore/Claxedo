import { createContext, createMemo, useContext, type Accessor, type JSX, type ParentProps } from "solid-js"
import { createSidePanelSize } from "@/lib/side-panel-size"
import { SIDE_PANEL_BORDER_WIDTH } from "@/lib/side-panel-motion"
import { useActiveSession } from "@/files"
import { persistedSignal, preferenceKey } from "@/lib/persisted"
import { useServer, type PlacementId, type ProductTelemetry } from "@/server"
import { useShellLayout, useShellRoute } from "@/shell"
import { closeReviewWorkspaceTab } from "./close"
import type { ReviewFocus } from "@/review"
import { filePathFromTab, panelFeature, type FileReveal, type PanelFeature, type PanelFocus } from "./focus"
import { rememberPanelPerSession, type SessionPanelSnapshot } from "./session-memory"
import { createPanelTabs } from "./tabs-store"
import {
  clampNavigatorWidth,
  clampPanelWidth,
  maxNavigatorWidth,
  restingNavigatorWidth,
  restingPanelWidth,
  workbenchInset,
} from "./width"
import type { ReviewWorkspaceTab, WorkspacePanelNavigator } from "./workspace-tabs"

export type PanelShowOptions = { readonly navigator?: WorkspacePanelNavigator | null }

export type Panel = {
  readonly placementId: Accessor<PlacementId | undefined>
  readonly sessionId: Accessor<string>
  readonly allowed: Accessor<boolean>
  readonly open: Accessor<boolean>
  readonly phone: Accessor<boolean>
  readonly tabs: Accessor<readonly ReviewWorkspaceTab[]>
  readonly activeTab: Accessor<ReviewWorkspaceTab>
  readonly navigator: Accessor<WorkspacePanelNavigator | null>
  readonly openingNavigator: Accessor<WorkspacePanelNavigator | null>
  readonly fullWidth: Accessor<boolean>
  readonly maximized: Accessor<boolean>
  readonly width: Accessor<number>
  readonly available: Accessor<number>
  readonly inset: Accessor<number>
  readonly setAvailable: (width: number) => void
  readonly chooseWidth: (width: number) => void
  readonly navigatorWidth: Accessor<number>
  readonly navigatorMaxWidth: Accessor<number>
  readonly chooseNavigatorWidth: (width: number) => void
  readonly toggleFullWidth: () => void
  readonly toggle: () => void
  readonly close: () => void
  readonly show: (focus?: PanelFocus, options?: PanelShowOptions) => void
  readonly activate: (tabId: string) => void
  readonly closeTab: (tabId: string) => void
  readonly toggleNavigator: (navigator: WorkspacePanelNavigator) => void
  readonly fileReveal: Accessor<FileReveal | undefined>
  readonly reviewFocus: Accessor<ReviewFocus | undefined>
}

type PanelSize = Pick<
  Panel,
  | "phone"
  | "fullWidth"
  | "width"
  | "available"
  | "setAvailable"
  | "chooseWidth"
  | "navigatorWidth"
  | "navigatorMaxWidth"
  | "chooseNavigatorWidth"
>

const PanelContext = createContext<Panel>()

function readWidth(value: unknown): number | null | undefined {
  if (value === null) return null
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function createPanelSize(): PanelSize & { readonly setFullWidth: (fullWidth: boolean) => void } {
  const [chosen, setChosen] = persistedSignal<number | null>(preferenceKey("panel", "width"), null, readWidth)
  const size = createSidePanelSize({ chosen, onChoose: setChosen, width: restingPanelWidth, clamp: clampPanelWidth })
  const [navigatorChosen, setNavigatorChosen] = persistedSignal<number | null>(
    preferenceKey("panel", "navigatorWidth"),
    null,
    readWidth,
  )
  const row = () => size.width() - SIDE_PANEL_BORDER_WIDTH
  return {
    ...size,
    navigatorWidth: createMemo(() => restingNavigatorWidth(row(), navigatorChosen())),
    navigatorMaxWidth: () => maxNavigatorWidth(row()),
    chooseNavigatorWidth: (value) => setNavigatorChosen(Math.round(clampNavigatorWidth(value, row()))),
  }
}

function createOpenRules(input: {
  readonly layout: ReturnType<typeof useShellLayout>
  readonly tabs: ReturnType<typeof createPanelTabs>
  readonly size: PanelSize
  readonly setFullWidth: (fullWidth: boolean) => void
  readonly telemetry: ProductTelemetry
}): Pick<Panel, "openingNavigator" | "toggle" | "toggleFullWidth" | "show"> {
  const { layout, tabs, size, setFullWidth, telemetry } = input
  const used = (feature: PanelFeature | undefined) => {
    if (feature) telemetry.record({ event: "feature_used", properties: { feature } })
  }
  const onReview = () => tabs.activeTab().kind === "review"
  const openingNavigator = () => (onReview() ? (tabs.navigator() ?? "files") : tabs.navigator())
  return {
    openingNavigator,
    toggle: () => {
      if (layout.panelOpen()) setFullWidth(false)
      else if (onReview()) {
        tabs.setNavigator(openingNavigator())
        used("review")
      }
      layout.send({ type: "togglePanel" })
    },
    toggleFullWidth: () => {
      const next = !size.fullWidth()
      setFullWidth(next)
      if (next && tabs.navigator() === null && onReview()) tabs.setNavigator("changes")
    },
    show: (focus, options) => {
      if (focus) tabs.focus(focus)
      used(focus && panelFeature(focus))
      if (options?.navigator !== undefined) tabs.setNavigator(options.navigator)
      layout.send({ type: "showPanel" })
    },
  }
}

function restoreTab(tabs: ReturnType<typeof createPanelTabs>, tabId: string) {
  if (tabs.activeTab().id === tabId) return
  const path = filePathFromTab(tabId)
  if (path !== undefined) tabs.focus({ kind: "file", path })
  else if (tabs.tabs().some((tab) => tab.id === tabId)) tabs.activate(tabId)
}

function createSessionMemory(
  layout: ReturnType<typeof useShellLayout>,
  route: ReturnType<typeof useShellRoute>,
  tabs: ReturnType<typeof createPanelTabs>,
) {
  rememberPanelPerSession({
    sessionId: () => {
      const current = route.route()
      return current.kind === "session" ? current.sessionId : undefined
    },
    snapshot: (): SessionPanelSnapshot =>
      layout.panelOpen()
        ? { open: true, navigator: tabs.navigator(), activeTabId: tabs.activeTab().id }
        : { open: false },
    restore: (snapshot) => {
      if (!snapshot?.open) {
        if (layout.panelOpen()) layout.send({ type: "hidePanel" })
        return
      }
      tabs.setNavigator(snapshot.navigator)
      restoreTab(tabs, snapshot.activeTabId)
      layout.send({ type: "showPanel" })
    },
  })
}

export function PanelProvider(props: ParentProps): JSX.Element {
  const layout = useShellLayout()
  const route = useShellRoute()
  const placementId = route.placementId
  const session = useActiveSession()
  const sessionId = () => session()?.sessionId ?? ""
  const tabs = createPanelTabs(placementId, sessionId)
  createSessionMemory(layout, route, tabs)
  const { setFullWidth, ...size } = createPanelSize()
  const close = () => layout.send({ type: "hidePanel" })
  const panel: Panel = {
    ...size,
    ...tabs,
    placementId,
    sessionId,
    allowed: layout.panelAllowed,
    open: layout.panelShown,
    maximized: () => layout.panelShown() && (size.phone() || size.fullWidth()),
    inset: () =>
      workbenchInset({
        open: layout.panelShown(),
        phone: size.phone(),
        fullWidth: size.fullWidth(),
        width: size.width(),
      }),
    ...createOpenRules({ layout, tabs, size, setFullWidth, telemetry: useServer().telemetry }),
    close,
    closeTab: (tabId) => closeReviewWorkspaceTab({ id: tabId, closePanel: close, closeTab: tabs.closeTab }),
  }
  return <PanelContext.Provider value={panel}>{props.children}</PanelContext.Provider>
}

export function usePanel(): Panel {
  const panel = useContext(PanelContext)
  if (!panel) throw new Error("usePanel needs a PanelProvider above it")
  return panel
}
