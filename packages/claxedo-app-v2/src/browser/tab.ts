import { createSignal, onCleanup, type Accessor } from "solid-js"
import type { PlacementId } from "@/server"
import { unreachable } from "@/lib/machine"
import type { BrowserBridge, BrowserResult, BrowserWebview } from "./bridge"
import { GUEST_PICKER_MODE_CHANNEL } from "./guest"
import {
  createBrowserTabMachine,
  type BrowserAction,
  type BrowserConsoleEntry,
  type BrowserHistory,
  type BrowserNotice,
  type BrowserSelection,
  type BrowserTabEvent,
  type BrowserTabState,
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
  readonly notice: Accessor<BrowserNotice | undefined>
  readonly notify: (notice: BrowserNotice | undefined) => void
  readonly selection: Accessor<BrowserSelection | undefined>
  readonly select: (selection: BrowserSelection | undefined) => void
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

function actionCall(
  bridge: BrowserBridge,
  paneId: string,
  action: BrowserAction,
): (() => Promise<BrowserResult>) | undefined {
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
  readonly notify: (notice: BrowserNotice | undefined) => void
  readonly refreshHistory: () => Promise<void>
}

async function runAction(host: ActionHost, action: BrowserAction) {
  const call = host.bridge && actionCall(host.bridge, host.paneId, action)
  if (!call) {
    host.notify({ key: "browser.notice.desktopOnly" })
    return
  }
  const result = await call()
  if (!result.ok) {
    if (navigational(action)) host.send({ type: "failed", reason: result.error ?? action })
    else host.notify(result.error ? { text: result.error } : { key: "browser.notice.actionFailed" })
    return
  }
  if (action === "clearCookies") host.notify({ key: "browser.notice.cookiesCleared" })
  if (navigational(action)) await host.refreshHistory()
}

function createNavigation(bridge: BrowserBridge | undefined, paneId: string, notify: (notice: BrowserNotice) => void) {
  const [history, setHistory] = createSignal<BrowserHistory>({ canGoBack: false, canGoForward: false })
  const refreshHistory = async () => {
    const read = bridge?.getNavigationState
    if (!read) return
    try {
      const result = await read(paneId)
      if (result.ok) setHistory({ canGoBack: result.canGoBack, canGoForward: result.canGoForward })
      else notify({ text: result.error })
    } catch (error) {
      console.error("Browser history could not be read", { paneId, error })
      notify({ key: "browser.notice.actionFailed" })
    }
  }
  return { history, refreshHistory }
}

type PageContext = {
  readonly bridge: BrowserBridge | undefined
  readonly paneId: string
  readonly send: (event: BrowserTabEvent) => void
  readonly notify: (notice: BrowserNotice | undefined) => void
  readonly select: (selection: BrowserSelection | undefined) => void
}

async function navigatePage(page: PageContext, registered: boolean, url: string): Promise<void> {
  page.select(undefined)
  page.send({ type: "navigate", url })
  if (!page.bridge || !registered) return
  try {
    const result = await page.bridge.navigate(page.paneId, url)
    if (!result.ok) page.send({ type: "failed", reason: result.error ?? url })
  } catch (error) {
    page.send({ type: "failed", reason: error instanceof Error ? error.message : String(error) })
  }
}

function sendPickerMode(page: PageContext, element: BrowserWebview | undefined, on: boolean): void {
  if (!element?.send) {
    page.notify({ key: page.bridge ? "browser.notice.pageNotReady" : "browser.notice.desktopOnly" })
    return
  }
  try {
    element.send(GUEST_PICKER_MODE_CHANNEL, on ? "comment" : "off")
  } catch (error) {
    console.error("Browser picker mode could not reach the page", { paneId: page.paneId, error })
    page.notify({ key: "browser.notice.pageNotReady" })
    return
  }
  page.send({ type: on ? "startPicking" : "stopPicking" })
  if (!on) page.select(undefined)
}

function guardedAction(host: ActionHost, action: BrowserAction): Promise<void> {
  return runAction(host, action).catch((error: unknown) => {
    console.error("Browser action failed", { paneId: host.paneId, action, error })
    host.notify({ key: "browser.notice.actionFailed" })
  })
}

export function createBrowserTab(placementId: PlacementId, bridge: BrowserBridge | undefined): BrowserTab {
  const paneId = `browser:${placementId}`
  const machine = createBrowserTabMachine("")
  const log = createConsoleLog(bridge, paneId)
  const [consoleOpen, setConsoleOpen] = createSignal(false)
  const [notice, notify] = createSignal<BrowserNotice | undefined>()
  const [selection, select] = createSignal<BrowserSelection | undefined>()
  const [webview, setWebview] = createSignal<BrowserWebview | undefined>()
  const [registered, setRegistered] = createSignal(false)
  const navigation = createNavigation(bridge, paneId, notify)
  const page: PageContext = { bridge, paneId, send: machine.send, notify, select }
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
    webview,
    attachWebview: (element) => {
      setWebview(element)
      setRegistered(false)
    },
    registered,
    markRegistered: () => setRegistered(true),
    navigate: (url) => navigatePage(page, registered(), url),
    setPicking: (on) => sendPickerMode(page, webview(), on),
    act: (action) => guardedAction(host, action),
  }
}
