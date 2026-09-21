/**
 * Main-process wiring for the agent-browser feature.
 *
 * Call `setupBrowserTab()` once at startup (inside `app.whenReady` so the
 * session partition is available). Enabled by default; setting
 * `CLAXEDO_ENABLE_BROWSER_TAB=0` disables it for diagnostics.
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
import { readString } from "../../shared/json-read"
import { configureAgentBrowserPartition, installAgentBrowserNavigationGuards } from "./partition"
import { BrowserRegistry } from "./registry"
import { AGENT_BROWSER_PARTITION, createWillAttachWebviewHandler } from "./will-attach-webview"

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
  // is a strict superset of what our pure handler expects, so it passes
  // straight through.
  const willAttachListener = (event: Event, webPreferences: WebPreferences, params: Record<string, string>) => {
    willAttach(event, webPreferences, params)
  }

  const registry = new BrowserRegistry((id) => electronWebContents.fromId(id) ?? undefined)

  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", willAttachListener)
    // If this web-contents itself belongs to the agent-browser partition (i.e.
    // it is a guest), harden its navigation surface too.
    try {
      // `partition` is a runtime-only field on `Session` — Electron does not
      // declare it — so probe for it instead of asserting it exists.
      const sessionPartition = readString(contents.session, "partition")
      // A guest only reaches this event if its attach survived the
      // will-attach-webview gate, which pins the partition — so a webview
      // already carrying it came through the sanctioned path. Registration
      // (browser:register) refuses any webContentsId never admitted here.
      if (contents.getType?.() === "webview" && sessionPartition === AGENT_BROWSER_PARTITION) {
        registry.admitGuest(contents.id)
        contents.once("destroyed", () => registry.dropGuest(contents.id))
      }
      if (contents.getType?.() === "webview" || sessionPartition === AGENT_BROWSER_PARTITION) {
        installAgentBrowserNavigationGuards(contents)
      }
    } catch (err) {
      log.warn("[browser-tab] failed to install navigation guards", { error: String(err) })
    }
  })

  // `session.fromPartition` requires the `app` to be ready. Defer to
  // `whenReady` so callers can invoke `setupBrowserTab` at module scope.
  // Fire-and-forget: the callback swallows its own failures and `whenReady`
  // itself never rejects, so there is no rejection for a caller to handle.
  void app.whenReady().then(() => {
    try {
      configureAgentBrowserPartition()
    } catch (err) {
      log.error("[browser-tab] failed to configure partition", { error: String(err) })
    }
  })

  return { registry, partition: AGENT_BROWSER_PARTITION }
}
