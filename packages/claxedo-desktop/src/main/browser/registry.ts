/**
 * BrowserRegistry — keeps a `paneId -> BrowserHandle` map in the main process.
 *
 * The renderer calls `browser:register(paneId, webContentsId)` after the guest
 * `<webview>` fires `dom-ready`; the main handler resolves the `WebContents`
 * via `webContents.fromId(id)` and invokes `register()` here. `unregister()`
 * runs on pane close / webview destruction.
 *
 * Lifecycle bookkeeping only. CDP attach/detach lives on `BrowserHandle`;
 * `unregister()` disposes the handle.
 */

import type { WebContents } from "electron"

import { BrowserHandle } from "./handle"

export type WebContentsFromId = (id: number) => WebContents | undefined

export class BrowserRegistry {
  #handles = new Map<string, BrowserHandle>()
  // webContents ids main recorded as agent-browser guests when the guest was
  // created (see setup.ts `web-contents-created`). `register` refuses anything
  // else, so a renderer cannot attach the pane machinery — and its CDP
  // debugger — to the host window's own webContents or any other non-guest.
  #guests = new Set<number>()
  #fromId: WebContentsFromId

  constructor(fromId: WebContentsFromId) {
    this.#fromId = fromId
  }

  /** Record that `webContentsId` belongs to a guest created through the pinned will-attach path. */
  admitGuest(webContentsId: number): void {
    this.#guests.add(webContentsId)
  }

  /** Forget a guest once its webContents is destroyed. */
  dropGuest(webContentsId: number): void {
    this.#guests.delete(webContentsId)
  }

  /**
   * Register a paneId -> webContents mapping. Returns the new handle.
   *
   * Throws if the webContentsId does not resolve, if it is destroyed, if it
   * was never admitted as a guest, if it is already bound to another pane, or
   * if the paneId is already registered to a different webContents. If the
   * same paneId + webContents pair is re-registered (e.g. dom-ready fires
   * twice), the existing handle is returned unchanged.
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
    if (!this.#guests.has(webContentsId)) {
      throw new Error(`BrowserRegistry.register: webContents ${webContentsId} is not an admitted guest`)
    }

    const existing = this.#handles.get(paneId)
    if (existing) {
      if (existing.webContentsId === webContentsId) return existing
      throw new Error(
        `BrowserRegistry.register: paneId ${paneId} already bound to different webContents ${existing.webContentsId}`,
      )
    }
    for (const [boundPane, bound] of this.#handles) {
      if (bound.webContentsId === webContentsId) {
        throw new Error(
          `BrowserRegistry.register: webContents ${webContentsId} is already bound to pane ${boundPane}`,
        )
      }
    }

    const handle = new BrowserHandle(wc)
    this.#handles.set(paneId, handle)
    return handle
  }

  /**
   * Unregister a paneId. Disposes the handle (detaches the CDP debugger and
   * removes event listeners) and removes the handle. Safe to call for an
   * unknown paneId.
   */
  unregister(paneId: string): void {
    const handle = this.#handles.get(paneId)
    if (!handle) return
    try {
      handle.dispose()
    } catch {
      // best-effort teardown; never throw from unregister
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
