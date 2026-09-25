import { isRecord } from "@claxedo/helpers/guards"
import type { BrowserConsoleEntry } from "./model"

export type BrowserResult = { readonly ok: boolean; readonly error?: string }

export type BrowserScreenshotResult =
  | { readonly ok: true; readonly dataUrl: string; readonly mimeType: "image/png" | "image/jpeg" }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message?: string } }

export type BrowserStorageKey = "cookies" | "localstorage" | "indexdb" | "cachestorage" | "serviceworkers"

export type BrowserNavigationState =
  | { readonly ok: true; readonly url: string; readonly canGoBack: boolean; readonly canGoForward: boolean }
  | { readonly ok: false; readonly error: string }

export type BrowserBridge = {
  readonly register: (paneId: string, webContentsId: number) => Promise<BrowserResult>
  readonly unregister: (paneId: string) => Promise<BrowserResult>
  readonly navigate: (paneId: string, url: string) => Promise<BrowserResult>
  readonly onConsoleEntry: (paneId: string, listener: (entry: BrowserConsoleEntry) => void) => () => void
  readonly captureScreenshot: (paneId: string) => Promise<BrowserScreenshotResult>
  readonly getNavigationState: (paneId: string) => Promise<BrowserNavigationState>
  readonly goBack: (paneId: string) => Promise<BrowserResult>
  readonly goForward: (paneId: string) => Promise<BrowserResult>
  readonly reload: (paneId: string, hard?: boolean) => Promise<BrowserResult>
  readonly openDevTools: (paneId: string) => Promise<BrowserResult>
  readonly clearStorage: (paneId: string, storages?: BrowserStorageKey[]) => Promise<BrowserResult>
}

export type BrowserWebview = HTMLElement & {
  readonly send?: (channel: string, ...args: unknown[]) => void
  readonly getWebContentsId?: () => number
  readonly capturePage?: () => Promise<{ readonly toDataURL: () => string; readonly isEmpty?: () => boolean }>
}

const REQUIRED_METHODS = [
  "register",
  "unregister",
  "navigate",
  "onConsoleEntry",
  "captureScreenshot",
  "getNavigationState",
  "goBack",
  "goForward",
  "reload",
  "openDevTools",
  "clearStorage",
] as const

function isBrowserBridge(value: unknown): value is BrowserBridge {
  return isRecord(value) && REQUIRED_METHODS.every((name) => typeof value[name] === "function")
}

export function readBrowserBridge(): BrowserBridge | undefined {
  if (typeof window === "undefined" || !("api" in window)) return undefined
  const api: unknown = window.api
  if (!isRecord(api)) return undefined
  return isBrowserBridge(api.browser) ? api.browser : undefined
}
