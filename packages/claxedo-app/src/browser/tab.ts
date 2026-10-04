import { createSignal, onCleanup, type Accessor } from "solid-js"
import type { PlacementId } from "@/server"
import { failureMessage } from "@/lib/failure"
import { unreachable } from "@/lib/machine"
import type { BrowserBridge, BrowserResult, BrowserWebview } from "./bridge"
import { GUEST_PICKER_MODE_CHANNEL } from "./guest"
import type { BrowserKey } from "./i18n"
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
  readonly navigateOnce: (url: string, version: number) => void
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

function actionCall(bridge: BrowserBridge, paneId: string, action: BrowserAction): Promise<BrowserResult> {
  switch (action) {
    case "back":
      return bridge.goBack(paneId)
    case "forward":
      return bridge.goForward(paneId)
    case "reload":
      return bridge.reload(paneId, false)
    case "hardReload":
      return bridge.reload(paneId, true)
    case "devTools":
      return bridge.openDevTools(paneId)
    case "clearCookies":
      return bridge.clearStorage(paneId, ["cookies"])
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

const FAILURE_KEY: Partial<Readonly<Record<BrowserAction, BrowserKey>>> = {
  hardReload: "browser.toast.hardReloadFailed",
  devTools: "browser.toast.devToolsFailed",
  clearCookies: "browser.toast.cookiesFailed",
}

function failureNotice(action: BrowserAction, error: string | undefined): BrowserNotice | undefined {
  const key = FAILURE_KEY[action]
  if (key) return { key, params: { error: error ?? "" } }
  if (navigational(action)) return undefined
  return error ? { text: error } : { key: "browser.toast.actionFailed" }
}

async function runAction(host: ActionHost, action: BrowserAction) {
  if (!host.bridge) {
    host.notify({ key: "browser.web.hint" })
    return
  }
  const result = await actionCall(host.bridge, host.paneId, action)
  if (!result.ok) {
    if (navigational(action)) host.send({ type: "failed", reason: result.error ?? action })
    const notice = failureNotice(action, result.error)
    if (notice) host.notify(notice)
    return
  }
  if (action === "clearCookies") host.notify({ key: "browser.toast.cookiesCleared" })
  if (navigational(action)) await host.refreshHistory()
}

function createNavigation(bridge: BrowserBridge | undefined, paneId: string, notify: (notice: BrowserNotice) => void) {
  const [history, setHistory] = createSignal<BrowserHistory>({ canGoBack: false, canGoForward: false })
  const refreshHistory = async () => {
    if (!bridge) return
    try {
      const result = await bridge.getNavigationState(paneId)
      if (result.ok) setHistory({ canGoBack: result.canGoBack, canGoForward: result.canGoForward })
      else notify({ text: result.error })
    } catch (error) {
      console.error("Browser history could not be read", { paneId, error })
      notify({ key: "browser.toast.actionFailed" })
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
    page.send({ type: "failed", reason: failureMessage(error) })
  }
}

function createPageNavigation(page: PageContext, registered: Accessor<boolean>) {
  let navigated: number | undefined
  return {
    navigate: (url: string) => navigatePage(page, registered(), url),
    navigateOnce: (url: string, version: number) => {
      if (navigated === version) return
      navigated = version
      void navigatePage(page, registered(), url)
    },
  }
}

function sendPickerMode(page: PageContext, element: BrowserWebview | undefined, on: boolean): void {
  if (!element?.send) {
    page.notify({ key: page.bridge ? "browser.toast.pageNotReady" : "browser.web.hint" })
    return
  }
  try {
    element.send(GUEST_PICKER_MODE_CHANNEL, on ? "comment" : "off")
  } catch (error) {
    console.error("Browser picker mode could not reach the page", { paneId: page.paneId, error })
    page.notify({ key: "browser.toast.pageNotReady" })
    return
  }
  page.send({ type: on ? "startPicking" : "stopPicking" })
  if (!on) page.select(undefined)
}

function guardedAction(host: ActionHost, action: BrowserAction): Promise<void> {
  return runAction(host, action).catch((error: unknown) => {
    console.error("Browser action failed", { paneId: host.paneId, action, error })
    host.notify({ key: "browser.toast.actionFailed" })
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
    ...createPageNavigation(page, registered),
    setPicking: (on) => sendPickerMode(page, webview(), on),
    act: (action) => guardedAction(host, action),
  }
}
