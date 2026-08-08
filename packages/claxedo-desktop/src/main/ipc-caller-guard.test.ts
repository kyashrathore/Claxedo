import { describe, expect, test } from "bun:test"
import { createIpcCallerGuard, installIpcCallerGuard, type GuardableIpcMain, type IpcCaller } from "./ipc-caller-guard"

const MAIN_RENDERER = 1
const OTHER = 2

function topFrame(senderId: number): IpcCaller {
  return { senderId, isMainFrame: true }
}

/** A minimal `ipcMain` that records registrations and can invoke them. */
function fakeIpcMain() {
  const handlers = new Map<string, (event: unknown, ...args: never[]) => unknown>()
  const listeners = new Map<string, (event: unknown, ...args: never[]) => void>()
  const ipcMain: GuardableIpcMain = {
    handle(channel, listener) {
      handlers.set(channel, listener as never)
    },
    on(channel, listener) {
      listeners.set(channel, listener as never)
    },
  }
  return {
    ipcMain,
    invoke: (channel: string, caller: IpcCaller, ...args: unknown[]) => handlers.get(channel)!(caller, ...(args as never[])),
    send: (channel: string, caller: IpcCaller, ...args: unknown[]) => listeners.get(channel)!(caller, ...(args as never[])),
  }
}

function install(onRejected?: (channel: string, reason: string) => void) {
  const guard = createIpcCallerGuard()
  guard.trust(MAIN_RENDERER)
  const fake = fakeIpcMain()
  const installed = installIpcCallerGuard({
    ipcMain: fake.ipcMain,
    guard,
    // The fake passes the caller through as the event.
    readCaller: (event) => event as IpcCaller,
    ...(onRejected ? { onRejected } : {}),
  })
  return { guard, fake, installed }
}

describe("createIpcCallerGuard", () => {
  test("allows the registered main renderer's top frame", () => {
    const guard = createIpcCallerGuard()
    guard.trust(MAIN_RENDERER)

    expect(guard.check(topFrame(MAIN_RENDERER))).toEqual({ allowed: true })
  })

  test("rejects an unregistered webContents", () => {
    // The agent-browser partition, a webview, an inherited about:blank window.
    const guard = createIpcCallerGuard()
    guard.trust(MAIN_RENDERER)

    expect(guard.check(topFrame(OTHER)).allowed).toBe(false)
  })

  test("rejects a subframe of the trusted webContents", () => {
    // An iframe shares its parent's webContents id, so the id alone would let
    // embedded remote content inherit the entire bridge.
    const guard = createIpcCallerGuard()
    guard.trust(MAIN_RENDERER)

    const verdict = guard.check({ senderId: MAIN_RENDERER, isMainFrame: false })
    expect(verdict.allowed).toBe(false)
    expect(verdict.allowed === false && verdict.reason).toContain("subframe")
  })

  test("rejects everything before anything is trusted", () => {
    // Fail closed. A guard installed but never handed a window must not be
    // open — that ordering bug should break the app loudly, not silently
    // disable the control.
    expect(createIpcCallerGuard().check(topFrame(MAIN_RENDERER)).allowed).toBe(false)
  })

  test("revocation takes effect, because Electron reuses webContents ids", () => {
    // A window destroyed without revoking would leave its id trusted, and the
    // next surface to receive that id would inherit the bridge.
    const guard = createIpcCallerGuard()
    guard.trust(MAIN_RENDERER)
    guard.revoke(MAIN_RENDERER)

    expect(guard.check(topFrame(MAIN_RENDERER)).allowed).toBe(false)
    expect(guard.trustedCount()).toBe(0)
  })
})

describe("installIpcCallerGuard", () => {
  test("guards a handler registered after installation", () => {
    const { fake } = install()
    let ran = 0
    fake.ipcMain.handle("open-path", () => {
      ran++
      return "ok"
    })

    expect(fake.invoke("open-path", topFrame(MAIN_RENDERER))).toBe("ok")
    expect(() => fake.invoke("open-path", topFrame(OTHER))).toThrow(/rejected/)
    expect(ran).toBe(1)
  })

  test("rejects rather than hanging, so a blocked call is a stack and not a mystery", () => {
    const { fake } = install()
    fake.ipcMain.handle("open-path", () => "ok")

    expect(() => fake.invoke("open-path", topFrame(OTHER))).toThrow(/ipc "open-path" rejected/)
  })

  test("drops a rejected send() and reports it", () => {
    // `on` has no reply channel, so dropping is the only answer available; the
    // report is what keeps it from being silent.
    const rejected: string[] = []
    const { fake } = install((channel, reason) => rejected.push(`${channel}: ${reason}`))
    let ran = 0
    fake.ipcMain.on("loading-complete", () => ran++)

    fake.send("loading-complete", topFrame(OTHER))
    expect(ran).toBe(0)
    expect(rejected[0]).toContain("loading-complete")

    fake.send("loading-complete", topFrame(MAIN_RENDERER))
    expect(ran).toBe(1)
  })

  test("counts every registration, so the wiring test can prove coverage", () => {
    const { fake, installed } = install()
    fake.ipcMain.handle("a", () => {})
    fake.ipcMain.handle("b", () => {})
    fake.ipcMain.on("c", () => {})

    expect(installed.guardedCount()).toBe(3)
  })

  test("passes the event and arguments through untouched", () => {
    // A guard that mangled arguments would break 60 handlers at once.
    const { fake } = install()
    let seen: unknown[] = []
    fake.ipcMain.handle("echo", (event, ...args) => {
      seen = [event, ...args]
      return args.length
    })

    const caller = topFrame(MAIN_RENDERER)
    expect(fake.invoke("echo", caller, "x", 2)).toBe(2)
    expect(seen).toEqual([caller, "x", 2])
  })
})
