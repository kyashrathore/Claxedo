import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import type { Session } from "electron"

import { installRendererPermissionPolicy, RENDERER_PERMISSIONS, rendererPermissionAllowed } from "./renderer-permissions"

const APP = "file:///Applications/Claxedo.app/Contents/Resources/app/out/renderer/index.local.html"
const isTrustedDocument = (url: string) => url === APP

describe("renderer permission policy", () => {
  test("allows exactly what the app document uses", () => {
    expect([...RENDERER_PERMISSIONS].sort()).toEqual(["clipboard-read", "clipboard-sanitized-write", "notifications"])
  })

  test.each([...RENDERER_PERMISSIONS])("%s is granted to the app document's top frame", (permission) => {
    expect(rendererPermissionAllowed({ permission, requestingUrl: APP, isMainFrame: true }, isTrustedDocument)).toBe(true)
  })

  test.each([
    "geolocation",
    "media",
    "display-capture",
    "midi",
    "midiSysex",
    "pointerLock",
    "fullscreen",
    "openExternal",
    "hid",
    "serial",
    "usb",
    "fileSystem",
    "idle-detection",
    "keyboardLock",
    "window-management",
    "storage-access",
    "deprecated-sync-clipboard-read",
    "unknown",
  ])("%s is denied even to the app document", (permission) => {
    expect(rendererPermissionAllowed({ permission, requestingUrl: APP, isMainFrame: true }, isTrustedDocument)).toBe(false)
  })

  test("an allowed permission is denied to any other document", () => {
    expect(
      rendererPermissionAllowed(
        { permission: "notifications", requestingUrl: "https://evil.example/", isMainFrame: true },
        isTrustedDocument,
      ),
    ).toBe(false)
  })

  test("an allowed permission is denied to a subframe of the app document", () => {
    expect(
      rendererPermissionAllowed({ permission: "notifications", requestingUrl: APP, isMainFrame: false }, isTrustedDocument),
    ).toBe(false)
  })

  test("a check that names no document is denied", () => {
    expect(
      rendererPermissionAllowed({ permission: "notifications", requestingUrl: undefined, isMainFrame: true }, isTrustedDocument),
    ).toBe(false)
  })
})

describe("renderer permission handlers", () => {
  type Request = Parameters<Session["setPermissionRequestHandler"]>[0]
  type Check = Parameters<Session["setPermissionCheckHandler"]>[0]

  function fakeSession() {
    const handlers: { request?: Request; check?: Check } = {}
    const session = {
      setPermissionRequestHandler: (handler: Request) => {
        handlers.request = handler
      },
      setPermissionCheckHandler: (handler: Check) => {
        handlers.check = handler
      },
    }
    return { session, handlers }
  }

  test("installs both handlers and they answer from the policy", () => {
    const { session, handlers } = fakeSession()
    installRendererPermissionPolicy(session, isTrustedDocument)
    const request = handlers.request
    const check = handlers.check
    if (!request || !check) throw new Error("both handlers must be installed")

    const answers: boolean[] = []
    const wc = null as unknown as Electron.WebContents
    request(wc, "notifications", (granted) => answers.push(granted), { requestingUrl: APP, isMainFrame: true })
    request(wc, "geolocation", (granted) => answers.push(granted), { requestingUrl: APP, isMainFrame: true })
    request(wc, "notifications", (granted) => answers.push(granted), {
      requestingUrl: "https://evil.example/",
      isMainFrame: true,
    })
    expect(answers).toEqual([true, false, false])

    expect(check(null, "clipboard-sanitized-write", "file://", { requestingUrl: APP, isMainFrame: true })).toBe(true)
    expect(check(null, "media", "file://", { requestingUrl: APP, isMainFrame: true })).toBe(false)
    expect(check(null, "clipboard-read", "file://", { isMainFrame: true })).toBe(false)
  })
})

describe("renderer permission wiring", () => {
  // `windows.ts` imports electron, so the fact that the main window's session
  // gets this policy is read off the source, as the caller-guard wiring is.
  const windows = readFileSync(path.join(import.meta.dir, "windows.ts"), "utf8")
  const mainWindow = windows.slice(
    windows.indexOf("export function createMainWindow"),
    windows.indexOf("export function loadMainWindow"),
  )

  test("the main window's session gets the policy", () => {
    expect(mainWindow).toContain("installRendererPermissionPolicy(win.webContents.session, isTrustedMainRendererUrl)")
  })
})
