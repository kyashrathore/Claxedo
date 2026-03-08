import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library"

vi.mock("../../../overrides/components/terminal-connection", () => {
  class WebSocketCloseError extends Error {
    code: number
    reason: string
    constructor(code: number, reason: string) {
      super(reason)
      this.code = code
      this.reason = reason
    }
  }
  return { WebSocketCloseError }
})

vi.mock("@/components/terminal", () => ({
  Terminal: (props: any) => (
    <button
      data-testid={`terminal-${props.pty?.id}`}
      onClick={() => {
        void import("../../../overrides/components/terminal-connection").then(({ WebSocketCloseError }) => {
          void props.onConnectError(new WebSocketCloseError(1008, "Session not found"))
        })
      }}
    >
      crash
    </button>
  ),
}))

vi.mock("@opencode-ai/ui/toast", () => ({
  showToast: vi.fn(),
}))

vi.mock("@opencode-ai/ui/icon-button", () => ({
  IconButton: (props: any) => <button aria-label={props["aria-label"]} onClick={props.onClick} />,
}))

vi.mock("@opencode-ai/ui/icon", () => ({
  Icon: () => <span />,
}))

import { createTerminalPanelRenderers } from "./renderers"

afterEach(() => {
  cleanup()
  document.body.innerHTML = ""
})

describe("createTerminalPanelRenderers", () => {
  test("clone-on-reconnect swaps pane id when socket closes with 1008", async () => {
    const clone = vi.fn(async () => "pty-new")
    const replace: Array<{ tab: string; from: string; to: string }> = []
    const patches: Array<{ id: string; patch: Record<string, unknown> }> = []
    const tabsState = [
      {
        id: "tab-1",
        type: "terminal" as const,
        directory: "/ws",
        terminalId: "pty-old",
        title: "Terminal old",
        closable: true,
      },
    ]
    const tabs = {
      items: () => tabsState,
      patch: (id: string, patch: Record<string, unknown>) => patches.push({ id, patch }),
      addFile: vi.fn(),
      setActive: vi.fn(),
    } as any

    const renderers = createTerminalPanelRenderers({
      props: { tabId: "tab-1", directory: "/ws" },
      sdk: {
        directory: "/ws",
        client: { file: { read: vi.fn() } },
      } as any,
      claxedo: {
        terminal: {
          zoom: () => undefined,
          replaceId: (tab: string, from: string, to: string) => replace.push({ tab, from, to }),
          resize: vi.fn(),
        },
      } as any,
      terminal: { clone } as any,
      tabs: () => tabs,
      paneRoot: () => ({ t: "leaf", id: "pty-old" }),
      map: () => new Map([["pty-old", { id: "pty-old", title: "Terminal old", titleNumber: 1, cwd: "/ws" }]]),
      splitPending: () => undefined,
      splitFor: vi.fn(),
      closePane: vi.fn(),
      detachPane: vi.fn(),
      focusPane: vi.fn(),
      persistUpdate: vi.fn(),
      moveState: () => undefined,
      overState: () => undefined,
      startMove: vi.fn(),
      resolveLiveFocus: () => "pty-old",
      log: vi.fn(),
    })

    const { container } = render(() => <renderers.FlatPaneRenderer />)
    fireEvent.click(container.querySelector("[data-testid='terminal-pty-old']") as HTMLButtonElement)

    await waitFor(() => {
      expect(clone).toHaveBeenCalledWith("pty-old")
      expect(replace).toEqual([{ tab: "tab-1", from: "pty-old", to: "pty-new" }])
      expect(patches).toEqual([{ id: "tab-1", patch: { terminalId: "pty-new", title: "Terminal old" } }])
    })
  })
})
