/**
 * BrowserHandle — main-process wrapper around a single agent-browser `<webview>`'s
 * `webContents`. Unit 2 stubs attach/detach as no-ops; Unit 3 fills in the CDP
 * state machine, screenshot, evaluate, and console buffering.
 */

import type { WebContents } from "electron"

export type BrowserHandleState = "detached" | "attaching" | "attached" | "reattaching"

export class BrowserHandle {
  #wc: WebContents
  #state: BrowserHandleState = "detached"

  constructor(wc: WebContents) {
    this.#wc = wc
  }

  get webContents(): WebContents {
    return this.#wc
  }

  get webContentsId(): number {
    return this.#wc.id
  }

  get state(): BrowserHandleState {
    return this.#state
  }

  /**
   * Attach the Chrome DevTools Protocol debugger to the underlying webContents.
   * Stubbed in Unit 2; Unit 3 wires the real state machine.
   */
  attach(): void {
    // no-op in Unit 2
  }

  /**
   * Detach the CDP debugger. Stubbed in Unit 2.
   */
  detach(): void {
    // no-op in Unit 2
  }

  /**
   * Navigate the underlying webContents to the given URL. Used by the
   * `browser:navigate` IPC channel. History / error wiring lands in Unit 3.
   */
  async navigate(url: string): Promise<void> {
    if (this.#wc.isDestroyed()) {
      throw new Error("webContents has been destroyed")
    }
    await this.#wc.loadURL(url)
  }
}
