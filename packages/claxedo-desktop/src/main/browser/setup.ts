/**
 * Main-process wiring for the agent-browser feature.
 *
 * Call `setupBrowserTab()` once at startup (inside `app.whenReady` so the
 * session partition is available). Guarded by `CLAXEDO_ENABLE_BROWSER_TAB=1`.
 *
 * When enabled, this:
 *   1. configures the `persist:agent-browser` session (default-deny permissions,
 *      block window-open, block downloads);
 *   2. installs the `will-attach-webview` allowlist on every new web-contents;
 *   3. returns a `BrowserRegistry` instance for the IPC layer to reach into.
 *
 * When disabled, returns `undefined` and does not register any hooks, so the
 * Electron shell behaves exactly as it did before this feature landed.
 */

import { app, webContents as electronWebContents } from "electron"
import type { Event, WebPreferences } from "electron"
import log from "electron-log/main.js"
import { existsSync } from "node:fs"
import path from "node:path"

import { isBrowserTabEnabled } from "./flag"
import { startDesktopHttpBridge, type BridgeHandle } from "./http-bridge"
import { configureAgentBrowserPartition, installAgentBrowserNavigationGuards } from "./partition"
import { BrowserRegistry } from "./registry"
import { ensureDesktopToken } from "./token"
import {
  AGENT_BROWSER_PARTITION,
  createWillAttachWebviewHandler,
  type WillAttachParams,
  type WillAttachWebPreferences,
} from "./will-attach-webview"

/**
 * Resolve the absolute filesystem path of the built browser-preload script.
 *
 * The preload ships at `out/preload/browser-preload.cjs` relative to the
 * packaged app root. In dev (`electron-vite dev`), `__dirname` points at
 * `out/main`, so the sibling `out/preload` resolution works identically;
 * in production the asar layout mirrors that. If the file is missing
 * (e.g. a partial build in CI), returns undefined so the handler falls
 * back to no preload — functionality degrades to a non-picker webview
 * rather than a black screen.
 *
 * Note: we return an absolute filesystem path, NOT a `file://` URL.
 * Electron's `webPreferences.preload` (set in main-process config) rejects
 * URLs with "preload script must have absolute path." The `<webview preload>`
 * DOM attribute accepts URLs, but this path goes through `will-attach-webview`
 * which sets `webPreferences.preload` directly.
 */
function resolveGuestPreloadUrl(): string | undefined {
  const candidates = [
    path.join(__dirname, "..", "preload", "browser-preload.cjs"),
    path.join(__dirname, "..", "..", "preload", "browser-preload.cjs"),
  ]
  for (const abs of candidates) {
    try {
      if (existsSync(abs)) return abs
    } catch {
      // ignore — try next candidate
    }
  }
  log.warn("[browser-tab] browser-preload.cjs not found; picker overlay will be disabled")
  return undefined
}

export type BrowserTabSetup = {
  registry: BrowserRegistry
  partition: string
  /**
   * Promise resolving to the started HTTP bridge. The bridge is started only
   * after `app.whenReady` because it needs the session partition already
   * configured to avoid spawning the MCP subprocess against an unreachable
   * URL. Callers that don't need the handle can ignore it.
   */
  bridge: Promise<BridgeHandle>
}

export function setupBrowserTab(): BrowserTabSetup | undefined {
  if (!isBrowserTabEnabled()) return undefined

  const willAttach = createWillAttachWebviewHandler({
    partition: AGENT_BROWSER_PARTITION,
    guestPreloadUrl: resolveGuestPreloadUrl(),
    onReject: (reason, params) => {
      log.warn("[browser-tab] will-attach-webview rejected", {
        reason,
        src: params.src,
        partition: params.partition,
      })
    },
  })

  // The Electron listener shape (`Event, WebPreferences, Record<string,string>`)
  // is a strict superset of what our pure handler expects. Adapt the params to
  // `WillAttachParams` (same values, slightly wider types) so the hardening
  // code can work with an ergonomic shape.
  const willAttachListener = (
    event: Event,
    webPreferences: WebPreferences,
    params: Record<string, string>,
  ) => {
    willAttach(
      event,
      webPreferences as WillAttachWebPreferences,
      params as unknown as WillAttachParams,
    )
  }

  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", willAttachListener)
    // If this web-contents itself belongs to the agent-browser partition (i.e.
    // it is a guest), harden its navigation surface too.
    try {
      const sessionPartition = (contents.session as unknown as { partition?: string } | undefined)?.partition
      if (contents.getType?.() === "webview" || sessionPartition === AGENT_BROWSER_PARTITION) {
        installAgentBrowserNavigationGuards(contents)
      }
    } catch (err) {
      log.warn("[browser-tab] failed to install navigation guards", { error: String(err) })
    }
  })

  // `session.fromPartition` requires the `app` to be ready. Defer to
  // `whenReady` so callers can invoke `setupBrowserTab` at module scope.
  app.whenReady().then(() => {
    try {
      configureAgentBrowserPartition()
    } catch (err) {
      log.error("[browser-tab] failed to configure partition", { error: String(err) })
    }
  })

  const registry = new BrowserRegistry((id) => electronWebContents.fromId(id) ?? undefined)

  // Mint the per-launch token up front so local agent tool subprocesses spawned
  // by this process can inherit a stable bridge credential.
  const token = ensureDesktopToken()
  process.env.CLAXEDO_DESKTOP_TOKEN = token

  // Start the HTTP bridge after `app.whenReady`. Writing the URL into
  // `process.env.CLAXEDO_DESKTOP_URL` gives local MCP tools a clear bridge
  // endpoint when they inherit the desktop process environment.
  const bridge = app.whenReady().then(async () => {
    try {
      const started = await startDesktopHttpBridge({ registry })
      process.env.CLAXEDO_DESKTOP_URL = started.url
      log.info("[browser-tab] bridge listening", { url: started.url })
      return started
    } catch (err) {
      log.error("[browser-tab] bridge failed to start", { error: String(err) })
      throw err
    }
  })

  return { registry, partition: AGENT_BROWSER_PARTITION, bridge }
}
