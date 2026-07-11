import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"

import { FIT_EVENT } from "../terminal/terminal-fit"
import { useRailShellChromeState } from "./rail-shell-chrome-state"

describe("useRailShellChromeState", () => {
  test("tracks desktop fullscreen changes for mac traffic-light padding", async () => {
    const previousApi = Object.getOwnPropertyDescriptor(window, "api")
    const listeners: ((fullscreen: boolean) => void)[] = []
    let unsubscribed = false
    Object.defineProperty(window, "api", {
      configurable: true,
      value: {
        getWindowFullscreen: () => Promise.resolve(false),
        onFullscreenChange: (callback: (fullscreen: boolean) => void) => {
          listeners.push(callback)
          return () => {
            unsubscribed = true
          }
        },
      },
    })

    const state = createRoot((dispose) => ({
      dispose,
      chrome: useRailShellChromeState({
        isMac: true,
        paneCount: () => 0,
        splitRoot: () => undefined,
      }),
    }))

    try {
      await Promise.resolve()
      expect(state.chrome.trafficLightPad()).toBe(true)
      listeners[0]?.(true)
      expect(state.chrome.trafficLightPad()).toBe(false)
      state.dispose()
      expect(unsubscribed).toBe(true)
    } finally {
      restoreWindowApi(previousApi)
    }
  })

  test("mobile drawer can be opened, toggled, and closed (opener was previously dead code)", () => {
    const state = createRoot((dispose) => ({
      dispose,
      chrome: useRailShellChromeState({
        isMac: false,
        paneCount: () => 0,
        splitRoot: () => undefined,
      }),
    }))

    try {
      // Starts closed. Before this WP there was no setter that could open it.
      expect(state.chrome.mobileSidebarOpen()).toBe(false)
      state.chrome.openMobileSidebar()
      expect(state.chrome.mobileSidebarOpen()).toBe(true)
      // Opening again is idempotent.
      state.chrome.openMobileSidebar()
      expect(state.chrome.mobileSidebarOpen()).toBe(true)
      state.chrome.closeMobileSidebar()
      expect(state.chrome.mobileSidebarOpen()).toBe(false)
      state.chrome.toggleMobileSidebar()
      expect(state.chrome.mobileSidebarOpen()).toBe(true)
      state.chrome.toggleMobileSidebar()
      expect(state.chrome.mobileSidebarOpen()).toBe(false)
    } finally {
      state.dispose()
    }
  })

  test("requests terminal fit after pane topology changes", async () => {
    const [paneCount, setPaneCount] = createSignal(1)
    const [splitRoot, setSplitRoot] = createSignal("root-a")
    let fitEvents = 0
    const countFit = () => {
      fitEvents += 1
    }
    window.addEventListener(FIT_EVENT, countFit)

    const dispose = createRoot((rootDispose) => {
      useRailShellChromeState({
        isMac: false,
        paneCount,
        splitRoot,
      })
      return rootDispose
    })

    try {
      setPaneCount(2)
      await Promise.resolve()
      expect(fitEvents).toBeGreaterThan(0)
      const beforeSplitChange = fitEvents
      setSplitRoot("root-b")
      await Promise.resolve()
      expect(fitEvents).toBeGreaterThan(beforeSplitChange)
    } finally {
      dispose()
      window.removeEventListener(FIT_EVENT, countFit)
    }
  })
})

function restoreWindowApi(previousApi: PropertyDescriptor | undefined) {
  if (previousApi) {
    Object.defineProperty(window, "api", previousApi)
    return
  }
  delete (window as { api?: unknown }).api
}
