import {
  createContext,
  createMemo,
  createSignal,
  useContext,
  type Accessor,
  type JSX,
  type ParentProps,
} from "solid-js"
import { usePhone } from "@/lib/viewport"
import { useActiveSession } from "@/files"
import { persistedSignal, preferenceKey } from "@/lib/persisted"
import type { PlacementId } from "@/server"
import { useShellLayout, useShellRoute } from "@/shell"
import { closeReviewWorkspaceTab } from "./close"
import type { ReviewFocus } from "@/review"
import { filePathFromTab, type FileReveal, type PanelFocus } from "./focus"
import { rememberPanelPerSession, type SessionPanelSnapshot } from "./session-memory"
import { createPanelTabs } from "./tabs-store"
import { clampPanelWidth, restingPanelWidth, workbenchInset } from "./width"
import type { ReviewWorkspaceTab, WorkspacePanelNavigator } from "./workspace-tabs"

export type PanelShowOptions = { readonly navigator?: WorkspacePanelNavigator | null }

export type Panel = {
  readonly placementId: Accessor<PlacementId | undefined>
  readonly sessionId: Accessor<string>
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

type PanelSize = Pick<Panel, "phone" | "fullWidth" | "width" | "available" | "setAvailable" | "chooseWidth">

const PanelContext = createContext<Panel>()

function readWidth(value: unknown): number | null | undefined {
  if (value === null) return null
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function createPanelSize(): PanelSize & { readonly setFullWidth: (fullWidth: boolean) => void } {
  const phone = usePhone()
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
    setFullWidth: (value) => setFullWidth(value),
  }
}

function createOpenRules(input: {
  readonly layout: ReturnType<typeof useShellLayout>
  readonly tabs: ReturnType<typeof createPanelTabs>
  readonly size: PanelSize
  readonly setFullWidth: (fullWidth: boolean) => void
}): Pick<Panel, "openingNavigator" | "toggle" | "toggleFullWidth" | "show"> {
  const { layout, tabs, size, setFullWidth } = input
  const onReview = () => tabs.activeTab().kind === "review"
  const openingNavigator = () => (onReview() ? (tabs.navigator() ?? "files") : tabs.navigator())
  return {
    openingNavigator,
    toggle: () => {
      if (layout.panelShown()) setFullWidth(false)
      else if (onReview()) tabs.setNavigator(openingNavigator())
      layout.send({ type: "togglePanel" })
    },
    toggleFullWidth: () => {
      const next = !size.fullWidth()
      setFullWidth(next)
      if (next && tabs.navigator() === null && onReview()) tabs.setNavigator("changes")
    },
    show: (focus, options) => {
      if (focus) tabs.focus(focus)
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
      layout.panelShown()
        ? { open: true, navigator: tabs.navigator(), activeTabId: tabs.activeTab().id }
        : { open: false },
    restore: (snapshot) => {
      if (!snapshot?.open) {
        if (layout.panelShown()) layout.send({ type: "hidePanel" })
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
    open: layout.panelShown,
    maximized: () => layout.panelShown() && (size.phone() || size.fullWidth()),
    inset: () =>
      workbenchInset({
        open: layout.panelShown(),
        phone: size.phone(),
        fullWidth: size.fullWidth(),
        width: size.width(),
      }),
    ...createOpenRules({ layout, tabs, size, setFullWidth }),
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
