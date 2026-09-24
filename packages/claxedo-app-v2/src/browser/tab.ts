import { createSignal, onCleanup, type Accessor } from "solid-js"
import type { PlacementId } from "@/server"
import { unreachable } from "@/lib/machine"
import type { BrowserBridge, BrowserResult, BrowserWebview } from "./bridge"
import { GUEST_PICKER_MODE_CHANNEL } from "./guest"
import { t } from "./i18n"
import {
  createBrowserTabMachine,
  type BrowserAction,
  type BrowserConsoleEntry,
  type BrowserHistory,
  type BrowserSelection,
  type BrowserTabEvent,
  type BrowserTabState,
  type PickedElement,
} from "./model"

const CONSOLE_CAP = 2000

export type BrowserTab = {
  readonly placementId: PlacementId
  readonly paneId: string
  readonly bridge: BrowserBridge | undefined
  readonly state: Accessor<BrowserTabState>
  readonly send: (event: BrowserTabEvent) => void
  readonly log: Accessor<readonly BrowserConsoleEntry[]>
  readonly clearLog: () => void
  readonly consoleOpen: Accessor<boolean>
  readonly setConsoleOpen: (open: boolean) => void
  readonly history: Accessor<BrowserHistory>
  readonly refreshHistory: () => Promise<void>
  readonly notice: Accessor<string | undefined>
  readonly notify: (message: string | undefined) => void
  readonly selection: Accessor<BrowserSelection | undefined>
  readonly select: (selection: BrowserSelection | undefined) => void
  readonly picks: Accessor<readonly PickedElement[]>
  readonly addPick: (pick: PickedElement) => void
  readonly removePick: (id: string) => void
  readonly takePicks: () => readonly PickedElement[]
  readonly webview: Accessor<BrowserWebview | undefined>
  readonly attachWebview: (element: BrowserWebview | undefined) => void
  readonly registered: Accessor<boolean>
  readonly markRegistered: () => void
  readonly navigate: (url: string) => Promise<void>
  readonly setPicking: (on: boolean) => void
  readonly act: (action: BrowserAction) => Promise<void>
}

function createConsoleLog(bridge: BrowserBridge | undefined, paneId: string) {
  const [entries, setEntries] = createSignal<readonly BrowserConsoleEntry[]>([])
  const append = (entry: BrowserConsoleEntry) =>
    setEntries((list) =>
      list.length >= CONSOLE_CAP ? [...list.slice(list.length - CONSOLE_CAP + 1), entry] : [...list, entry],
    )
  if (bridge) onCleanup(bridge.onConsoleEntry(paneId, append))
  return { entries, clear: () => setEntries([]) }
}

function createPickList() {
  const [picks, setPicks] = createSignal<readonly PickedElement[]>([])
  return {
    picks,
    add: (pick: PickedElement) => setPicks((list) => [...list, pick]),
    remove: (id: string) => setPicks((list) => list.filter((pick) => pick.id !== id)),
    take: () => {
      const list = picks()
      setPicks([])
      return list
    },
  }
}

function actionCall(bridge: BrowserBridge, paneId: string, action: BrowserAction): (() => Promise<BrowserResult>) | undefined {
  switch (action) {
    case "back": {
      const call = bridge.goBack
      return call ? () => call(paneId) : undefined
    }
    case "forward": {
      const call = bridge.goForward
      return call ? () => call(paneId) : undefined
    }
    case "reload": {
      const call = bridge.reload
      return call ? () => call(paneId, false) : undefined
    }
    case "hardReload": {
      const call = bridge.reload
      return call ? () => call(paneId, true) : undefined
    }
    case "devTools": {
      const call = bridge.openDevTools
      return call ? () => call(paneId) : undefined
    }
    case "clearCookies": {
      const call = bridge.clearStorage
      return call ? () => call(paneId, ["cookies"]) : undefined
    }
    default:
      return unreachable(action)
  }
}

function navigational(action: BrowserAction) {
  return action === "back" || action === "forward" || action === "reload" || action === "hardReload"
}

type ActionHost = {
  readonly bridge: BrowserBridge | undefined
  readonly paneId: string
  readonly send: (event: BrowserTabEvent) => void
  readonly notify: (message: string | undefined) => void
  readonly refreshHistory: () => Promise<void>
}

async function runAction(host: ActionHost, action: BrowserAction) {
  const call = host.bridge && actionCall(host.bridge, host.paneId, action)
  if (!call) {
    host.notify(t("browser.notice.desktopOnly"))
    return
  }
  const result = await call()
  if (!result.ok) {
    if (navigational(action)) host.send({ type: "failed", reason: result.error ?? action })
    else host.notify(result.error ?? action)
    return
  }
  if (action === "clearCookies") host.notify(t("browser.notice.cookiesCleared"))
  if (navigational(action)) await host.refreshHistory()
}

function createNavigation(bridge: BrowserBridge | undefined, paneId: string, notify: (message: string) => void) {
  const [history, setHistory] = createSignal<BrowserHistory>({ canGoBack: false, canGoForward: false })
  const refreshHistory = async () => {
    const read = bridge?.getNavigationState
    if (!read) return
    const result = await read(paneId)
    if (!result.ok) {
      notify(result.error)
      return
    }
    setHistory({ canGoBack: result.canGoBack, canGoForward: result.canGoForward })
  }
  return { history, refreshHistory }
}

export function createBrowserTab(placementId: PlacementId, bridge: BrowserBridge | undefined): BrowserTab {
  const paneId = `browser:${placementId}`
  const machine = createBrowserTabMachine("")
  const log = createConsoleLog(bridge, paneId)
  const [consoleOpen, setConsoleOpen] = createSignal(false)
  const [notice, notify] = createSignal<string | undefined>()
  const [selection, select] = createSignal<BrowserSelection | undefined>()
  const picks = createPickList()
  const [webview, setWebview] = createSignal<BrowserWebview | undefined>()
  const [registered, setRegistered] = createSignal(false)
  const navigation = createNavigation(bridge, paneId, notify)

  const navigate = async (url: string) => {
    select(undefined)
    machine.send({ type: "navigate", url })
    if (!bridge || !registered()) return
    const result = await bridge.navigate(paneId, url)
    if (!result.ok) machine.send({ type: "failed", reason: result.error ?? url })
  }

  const setPicking = (on: boolean) => {
    const element = webview()
    if (!element?.send) {
      notify(t(bridge ? "browser.notice.pageNotReady" : "browser.notice.desktopOnly"))
      return
    }
    try {
      element.send(GUEST_PICKER_MODE_CHANNEL, on ? "comment" : "off")
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error))
      return
    }
    machine.send({ type: on ? "startPicking" : "stopPicking" })
    if (!on) select(undefined)
  }

  const host: ActionHost = { bridge, paneId, send: machine.send, notify, refreshHistory: navigation.refreshHistory }

  return {
    placementId,
    paneId,
    bridge,
    state: machine.state,
    send: machine.send,
    log: log.entries,
    clearLog: log.clear,
    consoleOpen,
    setConsoleOpen,
    history: navigation.history,
    refreshHistory: navigation.refreshHistory,
    notice,
    notify,
    selection,
    select,
    picks: picks.picks,
    addPick: picks.add,
    removePick: picks.remove,
    takePicks: picks.take,
    webview,
    attachWebview: (element) => {
      setWebview(element)
      setRegistered(false)
    },
    registered,
    markRegistered: () => setRegistered(true),
    navigate,
    setPicking,
    act: (action) => runAction(host, action),
  }
}
