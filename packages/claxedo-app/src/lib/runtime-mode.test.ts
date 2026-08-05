import { beforeEach, describe, expect, test } from "bun:test"
import { isDemoMode, isEmbedMode, urlRoutingEnabled } from "./runtime-mode"

beforeEach(() => {
  window.location.href = "http://localhost/"
})

describe("urlRoutingEnabled", () => {
  // The packaged desktop renderer is loaded with `win.loadFile(...)`, so its
  // document is file:// — writing a route onto it produced an unloadable
  // `file:///w/<dir>/<session>` that reloaded into a blank chrome-error page.
  // `protocol` is the value to branch on here: happy-dom and Chromium disagree
  // about a file:// page's `origin` ("null" vs "file://") but both report the
  // protocol as "file:", so this guard behaves the same in tests and the app.
  test("rejects the packaged desktop renderer's file:// document", () => {
    window.location.href = "file:///Applications/Claxedo.app/Contents/Resources/app.asar/out/renderer/index.html"
    expect(window.location.protocol).toBe("file:")
    expect(urlRoutingEnabled()).toBe(false)
  })

  test("rejects a file:// document that already carries a pushed route", () => {
    window.location.href = "file:///w/%2FUsers%2Fdev%2Frepo/ses_abc123"
    expect(urlRoutingEnabled()).toBe(false)
  })

  test("allows the dev server origin", () => {
    window.location.href = "http://localhost:4444/w/repo/ses_abc123"
    expect(urlRoutingEnabled()).toBe(true)
  })

  test("allows a deployed https origin", () => {
    window.location.href = "https://app.claxedo.com/s/ses_abc123"
    expect(urlRoutingEnabled()).toBe(true)
  })
})

describe("existing runtime mode predicates still read the document", () => {
  test("isDemoMode tracks the /demo path", () => {
    window.location.href = "http://localhost/demo/"
    expect(isDemoMode()).toBe(true)
    window.location.href = "http://localhost/w/repo"
    expect(isDemoMode()).toBe(false)
  })

  test("isEmbedMode tracks the embed search param", () => {
    window.location.href = "http://localhost/?embed=1"
    expect(isEmbedMode()).toBe(true)
    window.location.href = "http://localhost/"
    expect(isEmbedMode()).toBe(false)
  })
})
