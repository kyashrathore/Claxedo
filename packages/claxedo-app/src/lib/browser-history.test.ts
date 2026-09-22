import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { configureBrowserHistory, writeBrowserRoute } from "./browser-history"

const initialUrl = window.location.href
const initialState = window.history.state
afterEach(() => {
  configureBrowserHistory(true)
  window.location.href = initialUrl
  window.history.replaceState(initialState, "", initialUrl)
})

function observe(url: string) {
  window.location.href = url
  window.history.replaceState({ retained: "route-state" }, "", url)
  const replace = spyOn(window.history, "replaceState").mockImplementation(() => {})
  const push = spyOn(window.history, "pushState").mockImplementation(() => {})
  const events: string[] = []
  const onPopState = () => events.push("popstate")
  window.addEventListener("popstate", onPopState)
  return { replace, push, events, dispose: () => {
    replace.mockRestore()
    push.mockRestore()
    window.removeEventListener("popstate", onPopState)
  } }
}

describe("browser route writes", () => {
  test("an HTTP desktop document using MemoryRouter never changes its reload URL", () => {
    const observed = observe("http://localhost:5173/index.local.html")
    configureBrowserHistory(false)
    try {
      writeBrowserRoute("/s/session", { replace: true, notify: true })
      expect(observed.replace.mock.calls).toEqual([])
      expect(observed.events).toEqual([])
    } finally { observed.dispose() }
  })

  test.each([true, false])("a file-backed document neither writes nor notifies (replace=%s)", (replace) => {
    const observed = observe("file:///Applications/Claxedo/index.html")
    try {
      writeBrowserRoute("/s/session", { replace, notify: true })
      expect(observed.replace.mock.calls).toEqual([])
      expect(observed.push.mock.calls).toEqual([])
      expect(observed.events).toEqual([])
    } finally { observed.dispose() }
  })

  test("a notified replacement preserves history state and signals the router", () => {
    const observed = observe("https://app.test/")
    try {
      writeBrowserRoute("/s/session", { replace: true, notify: true })
      expect(observed.replace.mock.calls).toEqual([[{ retained: "route-state" }, "", "/s/session"]])
      expect(observed.push.mock.calls).toEqual([])
      expect(observed.events).toEqual(["popstate"])
    } finally { observed.dispose() }
  })

  test("a quiet terminal replacement leaves the mounted router undisturbed", () => {
    const observed = observe("http://localhost/")
    try {
      writeBrowserRoute("/w/workspace/terminal/pty", { replace: true, notify: false })
      expect(observed.replace.mock.calls).toHaveLength(1)
      expect(observed.events).toEqual([])
    } finally { observed.dispose() }
  })

  test("a notification pushes a new entry and signals the router", () => {
    const observed = observe("https://app.test/")
    try {
      writeBrowserRoute("/s/session", { replace: false, notify: true })
      expect(observed.push.mock.calls).toEqual([[null, "", "/s/session"]])
      expect(observed.replace.mock.calls).toEqual([])
      expect(observed.events).toEqual(["popstate"])
    } finally { observed.dispose() }
  })
})
