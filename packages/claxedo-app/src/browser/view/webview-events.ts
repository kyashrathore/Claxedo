import { failureMessage } from "@/lib/failure"
import { readArray, readBoolean, readFiniteNumber, readString } from "@claxedo/helpers/readers"
import { uuid } from "@/lib/uuid"
import type { BrowserBridge, BrowserWebview } from "../bridge"
import {
  GUEST_PICK_CHANNEL,
  GUEST_SUBMIT_CHANNEL,
  guestCommentText,
  guestMessageArgument,
  readGuestPickPayload,
  type GuestPickPayload,
} from "../guest"
import type { PickDelivery } from "../pick-to-composer"
import type { BrowserTab } from "../tab"
import { sameOrigin } from "../url"
import { sendThemeTokens } from "./guest-theme"

const ABORTED_LOAD = -3

export type WebviewHost = {
  readonly element: BrowserWebview
  readonly tab: BrowserTab
  readonly bridge: BrowserBridge
  readonly deliver: PickDelivery
}

async function register(host: WebviewHost): Promise<boolean> {
  const read = host.element.getWebContentsId
  if (!read) {
    host.tab.send({ type: "failed", reason: "The page has no web contents id" })
    return false
  }
  const result = await host.bridge.register(host.tab.paneId, read.call(host.element))
  if (!result.ok) host.tab.send({ type: "failed", reason: result.error ?? "register" })
  return result.ok
}

async function onDomReady(host: WebviewHost, first: boolean) {
  sendThemeTokens(host.element)
  if (!first) {
    host.tab.send({ type: "loaded", url: host.tab.state().url })
    await host.tab.refreshHistory()
    return
  }
  if (!(await register(host))) return
  host.tab.markRegistered()
  const url = host.tab.state().url
  if (url) await host.tab.navigate(url)
  else host.tab.send({ type: "loaded", url })
}

function onNavigated(host: WebviewHost, event: Event, kind: "load" | "inPage") {
  if (kind === "inPage" && readBoolean(event, "isMainFrame") !== true) return
  const url = readString(event, "url") ?? host.tab.state().url
  host.tab.select(undefined)
  host.tab.send(kind === "load" ? { type: "navigate", url } : { type: "moved", url })
  void host.tab.refreshHistory()
}

function onFailedLoad(host: WebviewHost, event: Event) {
  const code = readFiniteNumber(event, "errorCode")
  if (readBoolean(event, "isMainFrame") === false || code === ABORTED_LOAD) return
  const description = readString(event, "errorDescription")
  host.tab.send({ type: "failed", reason: description || `error ${code ?? "unknown"}` })
}

async function captureScreenshot(element: BrowserWebview): Promise<string | undefined> {
  const capture = element.capturePage
  if (!capture) return undefined
  const image = await capture.call(element)
  if (image.isEmpty?.()) return undefined
  return image.toDataURL()
}

async function submitPick(host: WebviewHost, payload: GuestPickPayload, pageUrl: string) {
  const selection = host.tab.selection()
  if (!selection || selection.selector !== payload.selector || selection.url !== pageUrl) return
  const screenshotDataUrl = await captureScreenshot(host.element)
  const delivered = host.deliver({
    id: uuid(),
    pageUrl,
    selector: payload.selector,
    tagName: payload.tagName ?? "element",
    outerHtml: payload.outerHtml,
    comment: guestCommentText(payload.content),
    screenshotDataUrl,
  })
  host.tab.setPicking(false)
  host.tab.notify({ key: delivered ? "browser.toast.pickSent" : "browser.toast.pickLocal" })
}

function onGuestMessage(host: WebviewHost, event: Event) {
  const channel = readString(event, "channel")
  if (channel !== GUEST_PICK_CHANNEL && channel !== GUEST_SUBMIT_CHANNEL) return
  if (host.tab.state().kind !== "picking") return
  const payload = readGuestPickPayload(guestMessageArgument({ args: readArray(event, "args") }))
  if (!payload) return
  const pageUrl = host.tab.state().url
  if (payload.frameUrl !== undefined && !sameOrigin(payload.frameUrl, pageUrl)) return
  if (channel === GUEST_PICK_CHANNEL) {
    host.tab.select({ selector: payload.selector, url: pageUrl })
    return
  }
  submitPick(host, payload, pageUrl).catch((error: unknown) => {
    console.error("Browser pick could not be added", { pageUrl, error })
    host.tab.notify({ key: "browser.toast.actionFailed" })
  })
}

export function attachWebviewEvents(host: WebviewHost): () => void {
  let first = true
  const domReady = () => {
    const initial = first
    first = false
    onDomReady(host, initial).catch((error: unknown) => host.tab.send({ type: "failed", reason: failureMessage(error) }))
  }
  const listeners: ReadonlyArray<readonly [string, (event: Event) => void]> = [
    ["dom-ready", domReady],
    ["did-navigate", (event) => onNavigated(host, event, "load")],
    ["did-navigate-in-page", (event) => onNavigated(host, event, "inPage")],
    ["did-fail-load", (event) => onFailedLoad(host, event)],
    ["ipc-message", (event) => onGuestMessage(host, event)],
  ]
  for (const [name, listener] of listeners) host.element.addEventListener(name, listener)
  return () => {
    for (const [name, listener] of listeners) host.element.removeEventListener(name, listener)
  }
}
