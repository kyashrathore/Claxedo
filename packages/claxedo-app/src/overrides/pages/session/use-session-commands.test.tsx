/**
 * Tests for the Unit 7 browser-tab hotkey gating.
 *
 * Rather than spinning up the full session-command harness (which would need
 * mocks for ~10 upstream contexts), we test the pure `openBrowserTabWithGate`
 * extracted in `browser/actions/browser-actions.ts`. The hotkey in
 * `use-session-commands.tsx` is a thin wrapper around it: it reads
 * `claxedoConfig.browserTabEnabled`, resolves the workspace dir from
 * `params.dir`/`sdk.directory`, and delegates to the helper.
 *
 * If the helper's contract holds, the command's onSelect behaves correctly
 * because the wrapper only adds context glue (no branching logic of its own).
 */

import { describe, expect, test } from "bun:test"
import {
  BROWSER_TAB_DISABLED_TOAST_TITLE,
  openBrowserTabWithGate,
} from "../../../browser/actions/browser-actions"

type StubClaxedo = {
  split: { groups: () => { id: string }[]; focusedId: () => string | undefined }
  groupWorktree: (id: string) => { default: () => string | undefined }
  groupTabs: (id: string) => {
    addBrowserTab: (dir: string, url?: string, title?: string) => string
    setActive: (id: string) => void
  }
  topTabs: {
    addBrowserTab: (dir: string, url?: string, title?: string) => string
    setActive: (id: string) => void
  }
  dispatch: (action: unknown) => void
}

function makeClaxedoStub(opts?: { addBrowserTabId?: string }) {
  const calls: {
    addBrowserTab: Array<[string, string | undefined, string | undefined]>
    setActive: string[]
    dispatch: unknown[]
  } = { addBrowserTab: [], setActive: [], dispatch: [] }

  const tabs = {
    addBrowserTab: (dir: string, url?: string, title?: string) => {
      calls.addBrowserTab.push([dir, url, title])
      return opts?.addBrowserTabId ?? "tab-1"
    },
    setActive: (id: string) => {
      calls.setActive.push(id)
    },
  }

  const claxedo: StubClaxedo = {
    split: {
      groups: () => [{ id: "g1" }],
      focusedId: () => "g1",
    },
    groupWorktree: () => ({ default: () => "/ws" }),
    groupTabs: () => tabs,
    topTabs: tabs,
    dispatch: (action) => {
      calls.dispatch.push(action)
    },
  }
  return { claxedo, calls }
}

describe("openBrowserTabWithGate (hotkey / menu gating)", () => {
  test("flag off: shows toast and does NOT create a tab", () => {
    const { claxedo, calls } = makeClaxedoStub()
    const toasts: any[] = []
    const result = openBrowserTabWithGate(
      {
        enabled: false,
        claxedo: claxedo as any,
        workspaceDir: "/ws",
      },
      (opts) => toasts.push(opts),
    )
    expect(result).toEqual({ ok: false, reason: "disabled" })
    expect(toasts).toHaveLength(1)
    expect(toasts[0].variant).toBe("default")
    expect(toasts[0].title).toBe(BROWSER_TAB_DISABLED_TOAST_TITLE)
    expect(calls.addBrowserTab).toHaveLength(0)
  })

  test("flag off + missing claxedo: single disabled toast, no tab created", () => {
    const toasts: any[] = []
    const result = openBrowserTabWithGate(
      {
        enabled: false,
        claxedo: undefined,
        workspaceDir: "/ws",
      },
      (opts) => toasts.push(opts),
    )
    expect(result).toEqual({ ok: false, reason: "disabled" })
    expect(toasts).toHaveLength(1)
    expect(toasts[0].title).toBe(BROWSER_TAB_DISABLED_TOAST_TITLE)
  })

  test("flag on but claxedo missing: still gated with disabled toast", () => {
    const toasts: any[] = []
    const result = openBrowserTabWithGate(
      {
        enabled: true,
        claxedo: undefined,
        workspaceDir: "/ws",
      },
      (opts) => toasts.push(opts),
    )
    expect(result).toEqual({ ok: false, reason: "disabled" })
    expect(toasts[0].title).toBe(BROWSER_TAB_DISABLED_TOAST_TITLE)
  })

  test("flag on but workspaceDir missing: emits no-workspace toast, no tab", () => {
    const { claxedo, calls } = makeClaxedoStub()
    const toasts: any[] = []
    const result = openBrowserTabWithGate(
      {
        enabled: true,
        claxedo: claxedo as any,
        workspaceDir: undefined,
      },
      (opts) => toasts.push(opts),
    )
    expect(result).toEqual({ ok: false, reason: "no-workspace" })
    expect(toasts).toHaveLength(1)
    expect(toasts[0].title).toMatch(/workspace/i)
    expect(calls.addBrowserTab).toHaveLength(0)
  })

  test("flag on + workspace: creates a browser tab with no URL", () => {
    const { claxedo, calls } = makeClaxedoStub({ addBrowserTabId: "tab-xyz" })
    const toasts: any[] = []
    const result = openBrowserTabWithGate(
      {
        enabled: true,
        claxedo: claxedo as any,
        workspaceDir: "/ws",
      },
      (opts) => toasts.push(opts),
    )
    expect(result).toEqual({ ok: true, id: "tab-xyz" })
    expect(toasts).toHaveLength(0)
    expect(calls.addBrowserTab).toEqual([["/ws", undefined, undefined]])
    expect(calls.setActive).toEqual(["tab-xyz"])
  })

  test("flag on + url + title: forwarded verbatim to the tab action", () => {
    const { claxedo, calls } = makeClaxedoStub()
    const result = openBrowserTabWithGate(
      {
        enabled: true,
        claxedo: claxedo as any,
        workspaceDir: "/ws",
        url: "https://example.com",
        title: "Example",
      },
      () => {},
    )
    expect(result.ok).toBe(true)
    expect(calls.addBrowserTab).toEqual([["/ws", "https://example.com", "Example"]])
  })
})
