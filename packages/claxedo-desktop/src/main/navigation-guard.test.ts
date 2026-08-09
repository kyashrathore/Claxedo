import { describe, expect, test } from "bun:test"

import { isSafeExternalUrl, navigationDecision, windowOpenDecision } from "./navigation-guard"

// The main window's preload exposes an IPC bridge that reaches `execFile`, and
// it re-runs for every document the window loads. So "does this window ever
// navigate off the app document" is a remote-code-execution question, not a
// navigation-UX question. These pin the policy that keeps it pinned.

const APP_URL = "file:///Applications/Claxedo.app/Contents/renderer/index.local.html"
const isTrusted = (input: string) => input.split("#")[0]!.split("?")[0] === APP_URL

describe("isSafeExternalUrl", () => {
  test("allows the schemes a clicked link legitimately means", () => {
    expect(isSafeExternalUrl("https://example.com/docs")).toBe(true)
    expect(isSafeExternalUrl("http://example.com")).toBe(true)
    expect(isSafeExternalUrl("mailto:someone@example.com")).toBe(true)
  })

  test("refuses schemes that make openExternal a launch primitive", () => {
    // file: opens bundles/executables via the OS handler.
    expect(isSafeExternalUrl("file:///Applications/Evil.app")).toBe(false)
    expect(isSafeExternalUrl("file:///etc/passwd")).toBe(false)
    // javascript:/data: are script-execution vectors.
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false)
    expect(isSafeExternalUrl("data:text/html,<script>alert(1)</script>")).toBe(false)
    // Platform-privileged schemes; the allowlist covers these without naming them.
    expect(isSafeExternalUrl("ms-msdt:/id")).toBe(false)
    expect(isSafeExternalUrl("smb://attacker/share")).toBe(false)
    expect(isSafeExternalUrl("vscode://file/etc/passwd")).toBe(false)
  })

  test("refuses input that is not a URL at all", () => {
    expect(isSafeExternalUrl("")).toBe(false)
    expect(isSafeExternalUrl("not a url")).toBe(false)
    expect(isSafeExternalUrl("//example.com")).toBe(false)
  })
})

describe("navigationDecision", () => {
  test("allows the app document, including hash/query routing", () => {
    expect(navigationDecision(APP_URL, isTrusted)).toEqual({ action: "allow" })
    expect(navigationDecision(`${APP_URL}#/s/session-123`, isTrusted)).toEqual({ action: "allow" })
  })

  test("sends an http(s) link to the OS browser instead of navigating this window", () => {
    // The regression: a plain `[text](https://evil.com)` in agent markdown has no
    // target, so it navigates the bridge-bearing window. It must leave instead.
    expect(navigationDecision("https://evil.com", isTrusted)).toEqual({
      action: "external",
      url: "https://evil.com",
    })
  })

  test("blocks a navigation that is neither the app nor a safe external URL", () => {
    expect(navigationDecision("file:///etc/passwd", isTrusted)).toEqual({
      action: "block",
      url: "file:///etc/passwd",
    })
    // A different local file in the app bundle is still not the app document.
    const sneaky = "file:///Applications/Claxedo.app/Contents/renderer/evil.html"
    expect(navigationDecision(sneaky, isTrusted)).toEqual({ action: "block", url: sneaky })
  })
})

describe("windowOpenDecision", () => {
  test("never allows — a child window would inherit the preload", () => {
    // Even the app's own URL is routed rather than granted a new bridge-bearing
    // window, so there is no "allow" branch to regress into.
    for (const url of [APP_URL, "https://example.com", "file:///etc/passwd"]) {
      expect(windowOpenDecision(url).action).not.toBe("allow")
    }
  })

  test("routes safe URLs out and drops the rest", () => {
    expect(windowOpenDecision("https://example.com")).toEqual({
      action: "external",
      url: "https://example.com",
    })
    expect(windowOpenDecision("file:///etc/passwd")).toEqual({
      action: "block",
      url: "file:///etc/passwd",
    })
  })
})
