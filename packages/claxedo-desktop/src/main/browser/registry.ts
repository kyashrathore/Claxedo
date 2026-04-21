/**
 * BrowserRegistry — keeps a `paneId -> BrowserHandle` map in the main process.
 *
 * The renderer calls `browser:register(paneId, webContentsId)` after the guest
 * `<webview>` fires `dom-ready`; the main handler resolves the `WebContents`
 * via `webContents.fromId(id)` and invokes `register()` here. `unregister()`
 * runs on pane close / webview destruction.
 *
 * Unit 2 only keeps the lifecycle bookkeeping. Attach/detach of CDP lives on
 * the `BrowserHandle` and is no-op here until Unit 3.
 */

import type { WebContents } from "electron"

import { BrowserHandle } from "./handle"

export type WebContentsFromId = (id: number) => WebContents | undefined

export class BrowserRegistry {
  #handles = new Map<string, BrowserHandle>()
  #fromId: WebContentsFromId

  constructor(fromId: WebContentsFromId) {
    this.#fromId = fromId
  }

  /**
   * Register a paneId -> webContents mapping. Returns the new handle.
   *
   * Throws if the webContentsId does not resolve, if it is destroyed, or if
   * the paneId is already registered to a different webContents. If the same
   * paneId + webContents pair is re-registered (e.g. dom-ready fires twice),
   * the existing handle is returned unchanged.
   */
  register(paneId: string, webContentsId: number): BrowserHandle {
    if (!paneId) {
      throw new Error("BrowserRegistry.register: paneId is required")
    }
    const wc = this.#fromId(webContentsId)
    if (!wc) {
      throw new Error(`BrowserRegistry.register: webContents ${webContentsId} not found`)
    }
    if (wc.isDestroyed()) {
      throw new Error(`BrowserRegistry.register: webContents ${webContentsId} is destroyed`)
    }

    const existing = this.#handles.get(paneId)
    if (existing) {
      if (existing.webContentsId === webContentsId) return existing
      throw new Error(
        `BrowserRegistry.register: paneId ${paneId} already bound to different webContents ${existing.webContentsId}`,
      )
    }

    const handle = new BrowserHandle(wc)
    this.#handles.set(paneId, handle)
    return handle
  }

  /**
   * Unregister a paneId. Detaches the CDP debugger (no-op in Unit 2) and
   * removes the handle. Safe to call for an unknown paneId.
   */
  unregister(paneId: string): void {
    const handle = this.#handles.get(paneId)
    if (!handle) return
    try {
      handle.detach()
    } catch {
      // best-effort detach; never throw from unregister
    }
    this.#handles.delete(paneId)
  }

  /**
   * Fetch the handle for a paneId, or undefined if none is registered.
   */
  get(paneId: string): BrowserHandle | undefined {
    return this.#handles.get(paneId)
  }

  /** Enumerate currently-registered paneIds (stable order). */
  paneIds(): string[] {
    return Array.from(this.#handles.keys())
  }

  /** Clear every handle. Detach attempts are best-effort. */
  clear(): void {
    for (const paneId of Array.from(this.#handles.keys())) {
      this.unregister(paneId)
    }
  }
}
