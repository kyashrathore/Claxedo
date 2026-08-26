import windowState from "electron-window-state"
import { app, BrowserWindow, nativeImage, shell, type WebContents } from "electron"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import log from "electron-log/main.js"

import { isBrowserTabEnabled } from "./browser/flag"
import { IS_PACKAGED } from "./constants"
import { parseWindowSize } from "./window-size"
import {
  MAIN_RENDERER_DOCUMENT,
  navigationDecision,
  windowOpenDecision,
  type NavigationDecision,
} from "./navigation-guard"
import { trustWindowWithBridge } from "./ipc-caller-guard"
import { isTrustedRendererDocumentUrl } from "./renderer-url-trust"

type Globals = {
  updaterEnabled: boolean
  packaged: boolean
  wsl: boolean
  deepLinks?: string[]
  startupIsolationStage?: string
}

const root = dirname(fileURLToPath(import.meta.url))

/**
 * The one document every build's main window loads, and the only one
 * `isTrustedMainRendererUrl` trusts. Optional signed capability is a dynamic
 * contribution chunk inside this base composition, never a second document.
 */
const RENDERER_DOCUMENT = MAIN_RENDERER_DOCUMENT

function iconsDir() {
  return IS_PACKAGED ? join(process.resourcesPath, "icons") : join(root, "../../resources/icons")
}

function iconPath() {
  const ext = process.platform === "win32" ? "ico" : "png"
  return join(iconsDir(), `icon.${ext}`)
}

export function setDockIcon() {
  if (process.platform !== "darwin") return
  app.dock?.setIcon(nativeImage.createFromPath(join(iconsDir(), "128x128@2x.png")))
}

export function createMainWindow(globals: Globals, options?: { deferLoad?: boolean }) {
  const startedAt = performance.now()
  if (process.env.CLAXEDO_PERF_READY_SELECTOR) log.info("[startup-perf] create-window start")
  const requestedWindowSize = parseWindowSize(app.commandLine.getSwitchValue("claxedo-window-size"))
  const state = windowState({
    defaultWidth: requestedWindowSize?.width ?? 1280,
    defaultHeight: requestedWindowSize?.height ?? 800,
  })
  if (process.env.CLAXEDO_PERF_READY_SELECTOR) {
    log.info(`[startup-perf] window-state ready elapsed=${String(Math.round(performance.now() - startedAt))}ms`)
  }

  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: requestedWindowSize?.width ?? state.width,
    height: requestedWindowSize?.height ?? state.height,
    show: false,
    backgroundColor: "#111111",
    title: app.getName(),
    icon: iconPath(),
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hidden" as const,
          trafficLightPosition: { x: 12, y: 12 },
        }
      : {}),
    ...(process.platform === "win32"
      ? {
          frame: false,
          titleBarStyle: "hidden" as const,
          titleBarOverlay: {
            color: "transparent",
            symbolColor: "#999",
            height: 40,
          },
        }
      : {}),
    webPreferences: {
      preload: join(root, "../preload/index.cjs"),
      sandbox: false,
      webviewTag: isBrowserTabEnabled(),
    },
  })
  wireNavigationGuard(win.webContents)
  // This window carries the preload bridge, so it is also an IPC caller we
  // trust. Granted here, beside the navigation guard, so the code that hands
  // out the bridge is the code that authorizes it.
  trustWindowWithBridge({
    webContentsId: win.webContents.id,
    onDestroyed: (listener) => win.webContents.once("destroyed", listener),
  })
  if (process.env.CLAXEDO_PERF_READY_SELECTOR) {
    log.info(`[startup-perf] browser-window ready elapsed=${String(Math.round(performance.now() - startedAt))}ms`)
  }

  state.manage(win)
  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) win.show()
  })
  if (!options?.deferLoad) loadMainWindow(win)
  wireZoom(win)
  wireDiagnostics(win)
  watchPerformanceReady(win)
  injectGlobals(win, globals)
  devtools(win)
  if (process.env.CLAXEDO_PERF_READY_SELECTOR) {
    log.info(`[startup-perf] create-window complete elapsed=${String(Math.round(performance.now() - startedAt))}ms`)
  }

  return win
}

export function loadMainWindow(win: BrowserWindow) {
  loadWindow(win, RENDERER_DOCUMENT)
}

/**
 * Apply the main-window navigation policy. See `./navigation-guard` for why the
 * main window must never navigate away from the app document — in short, the
 * preload's IPC bridge follows the window to whatever it loads, and that bridge
 * reaches `execFile`. Decisions live in that module; this only performs them.
 */
export function wireNavigationGuard(wc: WebContents) {
  const perform = (decision: NavigationDecision, context: string) => {
    if (decision.action === "external") void shell.openExternal(decision.url)
    else if (decision.action === "block") log.warn(`[security] blocked ${context} to ${decision.url}`)
  }
  wc.on("will-navigate", (event, urlString) => {
    const decision = navigationDecision(urlString, isTrustedMainRendererUrl)
    if (decision.action === "allow") return
    event.preventDefault()
    perform(decision, "main-window navigation")
  })
  wc.setWindowOpenHandler(({ url }) => {
    perform(windowOpenDecision(url), "window.open")
    return { action: "deny" as const }
  })
}

export function isTrustedMainRendererUrl(input: string) {
  return isTrustedRendererDocumentUrl(input, {
    devServerUrl: process.env.ELECTRON_RENDERER_URL,
    packagedIndexUrl: pathToFileURL(join(root, `../renderer/${RENDERER_DOCUMENT}`)).href,
  })
}

export function createLoadingWindow(globals: Globals) {
  const win = new BrowserWindow({
    width: 640,
    height: 480,
    resizable: false,
    center: true,
    show: true,
    icon: iconPath(),
    ...(process.platform === "darwin" ? { titleBarStyle: "hidden" as const } : {}),
    ...(process.platform === "win32"
      ? {
          frame: false,
          titleBarStyle: "hidden" as const,
          titleBarOverlay: {
            color: "transparent",
            symbolColor: "#999",
            height: 40,
          },
        }
      : {}),
    webPreferences: {
      preload: join(root, "../preload/index.cjs"),
      sandbox: false,
      webviewTag: isBrowserTabEnabled(),
    },
  })
  wireNavigationGuard(win.webContents)
  // This window carries the preload bridge, so it is also an IPC caller we
  // trust. Granted here, beside the navigation guard, so the code that hands
  // out the bridge is the code that authorizes it.
  trustWindowWithBridge({
    webContentsId: win.webContents.id,
    onDestroyed: (listener) => win.webContents.once("destroyed", listener),
  })

  loadWindow(win, "loading.html")
  injectGlobals(win, globals)

  return win
}

function loadWindow(win: BrowserWindow, html: string) {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    const url = new URL(html, devUrl)
    void win.loadURL(url.toString())
    return
  }

  void win.loadFile(join(root, `../renderer/${html}`))
}

function devtools(win: BrowserWindow) {
  if (!process.env.ELECTRON_RENDERER_URL || process.env.CLAXEDO_DEVTOOLS !== "1") return
  win.webContents.once("did-finish-load", () => {
    if (win.isDestroyed()) return
    win.webContents.openDevTools({ mode: "undocked" })
  })
}

function injectGlobals(win: BrowserWindow, globals: Globals) {
  win.webContents.on("dom-ready", () => {
    const deepLinks = globals.deepLinks ?? []
    const data = {
      updaterEnabled: globals.updaterEnabled,
      packaged: globals.packaged,
      wsl: globals.wsl,
      deepLinks: Array.isArray(deepLinks) ? deepLinks.splice(0) : deepLinks,
      startupIsolationStage: globals.startupIsolationStage,
    }
    void win.webContents.executeJavaScript(
      `window.__OPENCODE__ = Object.assign(window.__OPENCODE__ ?? {}, ${JSON.stringify(data)})`,
    )
  })
}

function wireZoom(win: BrowserWindow) {
  win.webContents.setZoomFactor(1)
  win.webContents.on("zoom-changed", () => {
    win.webContents.setZoomFactor(1)
  })
}

function wireDiagnostics(win: BrowserWindow) {
  win.on("unresponsive", () => {
    log.error("renderer unresponsive", { url: win.webContents.getURL() })
  })
  win.webContents.on("render-process-gone", (_event, details) => {
    log.error("renderer process gone", details)
  })
  win.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return
    log.error("renderer failed to load", { code, description, url })
  })
  if (IS_PACKAGED) return
  win.webContents.on("console-message", (details) => {
    if (details.level === "error") {
      log.error("renderer console", {
        message: details.message,
        source: details.sourceId,
        line: details.lineNumber,
      })
      return
    }
    if (details.level !== "warning") return
    log.warn("renderer console", {
      message: details.message,
      source: details.sourceId,
      line: details.lineNumber,
    })
  })
}

function watchPerformanceReady(win: BrowserWindow) {
  const selector = process.env.CLAXEDO_PERF_READY_SELECTOR
  if (!selector) return

  let rendererLoads = 0
  let readyLogged = false
  win.webContents.on("did-finish-load", () => {
    rendererLoads += 1
    const loadedAt = performance.now()
    log.info(`[startup-perf] renderer loaded count=${String(rendererLoads)}`)
    void win.webContents
      .executeJavaScript(`new Promise((resolve) => {
        const selector = ${JSON.stringify(selector)}
        if (document.querySelector(selector)) return resolve(true)
        const observer = new MutationObserver(() => {
          if (!document.querySelector(selector)) return
          observer.disconnect()
          resolve(true)
        })
        observer.observe(document.documentElement, { childList: true, subtree: true })
      })`)
      .then((ready) => {
        if (!ready || readyLogged) return
        readyLogged = true
        log.info(`[startup-perf] session list ready after-renderer=${String(Math.round(performance.now() - loadedAt))}ms`)
        return win.webContents.executeJavaScript(`performance.getEntriesByType("resource")
          .filter((entry) => entry.name.includes("/api/") || entry.name.includes("session-list"))
          .map((entry) => ({
            name: entry.name,
            startTime: Math.round(entry.startTime),
            duration: Math.round(entry.duration),
            responseEnd: Math.round(entry.responseEnd),
          }))`)
      })
      .then((resources) => {
        if (!resources) return
        log.info(`[startup-perf] renderer resources=${JSON.stringify(resources)}`)
      })
      .catch(() => undefined)
  })
}
