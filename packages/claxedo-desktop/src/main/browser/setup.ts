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

import { isBrowserTabEnabled } from "./flag"
import { configureAgentBrowserPartition, installAgentBrowserNavigationGuards } from "./partition"
import { BrowserRegistry } from "./registry"
import {
  AGENT_BROWSER_PARTITION,
  createWillAttachWebviewHandler,
  type WillAttachParams,
  type WillAttachWebPreferences,
} from "./will-attach-webview"

export type BrowserTabSetup = {
  registry: BrowserRegistry
  partition: string
}

export function setupBrowserTab(): BrowserTabSetup | undefined {
  if (!isBrowserTabEnabled()) return undefined

  const willAttach = createWillAttachWebviewHandler({
    partition: AGENT_BROWSER_PARTITION,
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

  return { registry, partition: AGENT_BROWSER_PARTITION }
}
