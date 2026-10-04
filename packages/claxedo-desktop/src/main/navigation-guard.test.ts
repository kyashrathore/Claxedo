import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

import { isOpenableLinkUrl, navigationDecision, windowOpenDecision } from "./navigation-guard"

// The main window's preload exposes an IPC bridge that reaches `execFile`, and
// it re-runs for every document the window loads. So "does this window ever
// navigate off the app document" is a remote-code-execution question, not a
// navigation-UX question. These pin the policy that keeps it pinned.

const APP_URL = "file:///Applications/Claxedo.app/Contents/renderer/index.local.html"
const isTrusted = (input: string) => input.split("#")[0].split("?")[0] === APP_URL

describe("isOpenableLinkUrl", () => {
  test("keeps everything a navigation may leave for", () => {
    expect(isOpenableLinkUrl("https://example.com/docs")).toBe(true)
    expect(isOpenableLinkUrl("http://example.com")).toBe(true)
    expect(isOpenableLinkUrl("mailto:someone@example.com")).toBe(true)
  })

  test("adds this app's scheme and the editor, which a click on a transcript link means", () => {
    expect(isOpenableLinkUrl("claxedo://documents/open?id=doc_1")).toBe(true)
    expect(isOpenableLinkUrl("vscode://file/Users/dev/notes.md:12")).toBe(true)
  })

  test("stops at those two — the rest still make openExternal a launch primitive", () => {
    expect(isOpenableLinkUrl("file:///Applications/Evil.app")).toBe(false)
    expect(isOpenableLinkUrl("javascript:alert(1)")).toBe(false)
    expect(isOpenableLinkUrl("data:text/html,<script>alert(1)</script>")).toBe(false)
    expect(isOpenableLinkUrl("smb://attacker/share")).toBe(false)
    expect(isOpenableLinkUrl("ms-msdt:/id")).toBe(false)
    expect(isOpenableLinkUrl("not a url")).toBe(false)
  })

  test("stays out of the navigation policy", () => {
    for (const url of ["https://example.com", "claxedo://x", "vscode://file/etc/passwd"]) {
      expect(windowOpenDecision(url)).toEqual({ action: "block", url })
      expect(navigationDecision(url, isTrusted)).toEqual({ action: "block", url })
    }
  })

  // The wider list is only sound while it reaches `shell.openExternal` through
  // the link IPC alone; ipc.ts cannot be imported here because it loads Electron.
  test("is the gate the open-link IPC uses", () => {
    const ipc = readFileSync(path.join(import.meta.dir, "ipc.ts"), "utf8")
    const handler = ipc.slice(ipc.indexOf('ipcMain.on("open-link"'))

    expect(handler).toStartWith('ipcMain.on("open-link"')
    expect(handler.indexOf("isOpenableLinkUrl(url)")).toBeLessThan(handler.indexOf("shell.openExternal(url)"))
  })
})

describe("navigationDecision", () => {
  test("allows the app document, including hash/query routing", () => {
    expect(navigationDecision(APP_URL, isTrusted)).toEqual({ action: "allow" })
    expect(navigationDecision(`${APP_URL}#/s/session-123`, isTrusted)).toEqual({ action: "allow" })
  })

  test("blocks every other navigation, including a safe external URL", () => {
    // A plain `[text](https://evil.com)` in agent markdown has no target, so it
    // would navigate the bridge-bearing window and carry the query string out.
    expect(navigationDecision("https://evil.com/?data=secret", isTrusted)).toEqual({ action: "block", url: "https://evil.com/?data=secret" })
    expect(navigationDecision("file:///etc/passwd", isTrusted)).toEqual({ action: "block", url: "file:///etc/passwd" })
    // A different local file in the app bundle is still not the app document.
    const sneaky = "file:///Applications/Claxedo.app/Contents/renderer/evil.html"
    expect(navigationDecision(sneaky, isTrusted)).toEqual({ action: "block", url: sneaky })
  })
})

describe("windowOpenDecision", () => {
  test("blocks every URL — a child window would inherit the preload", () => {
    for (const url of [APP_URL, "https://example.com", "http://127.0.0.1:9999/x", "mailto:someone@example.com", "file:///etc/passwd"]) {
      expect(windowOpenDecision(url)).toEqual({ action: "block", url })
    }
  })
})
