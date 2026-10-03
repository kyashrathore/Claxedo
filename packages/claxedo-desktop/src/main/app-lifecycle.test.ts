import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"

import { createAppLifecycle, type ExitIntent } from "./app-lifecycle"
import type { RunningWork } from "./daemon-quit"

function preventable() {
  let prevented = false
  return { preventDefault: () => { prevented = true }, prevented: () => prevented }
}

class FakeApp extends EventEmitter {
  quits = 0
  quit = () => {
    this.quits += 1
    const event = preventable()
    this.emit("before-quit", event)
    if (!event.prevented()) this.emit("quit")
  }
}

class FakeWindow extends EventEmitter {
  visible = true
  hide = () => { this.visible = false }
  show = () => { this.visible = true }
  focus = () => {}
  isDestroyed = () => false
  close() {
    const event = preventable()
    this.emit("close", event)
    if (!event.prevented()) this.emit("closed")
  }
}

function lifecycle(options: { platform?: NodeJS.Platform; work?: RunningWork; confirm?: boolean | "pending" } = {}) {
  const app = new FakeApp()
  const win = new FakeWindow()
  const power = new EventEmitter()
  const aborted: boolean[] = []
  const exits: ExitIntent[] = []
  const confirms: string[] = []
  const trays: Array<{ open: () => void; quit: () => void }> = []
  let quit = false
  app.on("quit", () => { quit = true })
  const subject = createAppLifecycle({
    app,
    powerMonitor: () => power,
    platform: options.platform ?? "darwin",
    window: () => win,
    ready: Promise.resolve(),
    createTray: (actions) => trays.push(actions),
    runningWork: async () => options.work,
    confirmQuit: async (message, signal) => {
      confirms.push(message)
      if (options.confirm !== "pending") return options.confirm ?? true
      return new Promise<boolean>((resolve) => signal.addEventListener("abort", () => {
        aborted.push(true)
        resolve(false)
      }))
    },
    exit: async (intent) => { exits.push(intent) },
    log: () => {},
  })
  subject.keepOnClose(win)
  return { app, win, power, subject, exits, confirms, aborted, trays, quit: () => quit }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("app lifecycle", () => {
  test("closing the window hides it, the app keeps running, and the Dock reopens it", () => {
    const { app, win, exits, quit } = lifecycle()

    win.close()
    app.emit("window-all-closed")

    expect(win.visible).toBe(false)
    expect(quit()).toBe(false)
    expect(exits).toEqual([])
    app.emit("activate")
    expect(win.visible).toBe(true)
  })

  test("off macOS the tray reopens the window and quits", async () => {
    const { app, win, trays, quit } = lifecycle({ platform: "win32" })
    await settle()
    expect(trays).toHaveLength(1)

    win.close()
    trays[0]!.open()
    expect(win.visible).toBe(true)
    trays[0]!.quit()
    await settle()
    expect(quit()).toBe(true)
    expect(app.quits).toBe(2)
  })

  test("a quit with running work asks first, and Cancel leaves everything running", async () => {
    const { app, win, exits, confirms, quit } = lifecycle({ work: { sessions: 2, terminals: 0 }, confirm: false })

    app.quit()
    await settle()

    expect(confirms).toEqual(["2 sessions are still working. Quitting stops them."])
    expect(exits).toEqual([])
    expect(quit()).toBe(false)
    win.close()
    expect(win.visible).toBe(false)
  })

  test("a confirmed quit stops the daemon before the app quits and lets the window close", async () => {
    const { app, win, exits, quit } = lifecycle({ work: { sessions: 1, terminals: 1 }, confirm: true })
    let closed = false
    win.on("closed", () => { closed = true })

    app.quit()
    await settle()

    expect(exits).toEqual(["quit"])
    expect(quit()).toBe(true)
    win.close()
    expect(closed).toBe(true)
  })

  test("a quit with nothing running stops the daemon without asking", async () => {
    const { app, exits, confirms, quit } = lifecycle({ work: { sessions: 0, terminals: 0 } })

    app.quit()
    await settle()

    expect(confirms).toEqual([])
    expect(exits).toEqual(["quit"])
    expect(quit()).toBe(true)
  })

  test("a same-build restart hands the daemon over without asking", async () => {
    const { app, subject, exits, confirms, quit } = lifecycle({ work: { sessions: 3, terminals: 0 } })

    await subject.requestExit("handoff", () => app.quit())

    expect(confirms).toEqual([])
    expect(exits).toEqual(["handoff"])
    expect(quit()).toBe(true)
  })

  test("an update installs through the same confirmed quit", async () => {
    const { subject, exits, confirms } = lifecycle({ work: { sessions: 1, terminals: 0 }, confirm: true })
    let installed = false

    await subject.requestExit("quit", () => { installed = true })

    expect(confirms).toEqual(["1 session is still working. Quitting stops it."])
    expect(exits).toEqual(["quit"])
    expect(installed).toBe(true)
  })

  test("an OS shutdown stops the daemon without asking and holds the shutdown until then", async () => {
    const { power, exits, confirms, quit } = lifecycle({ work: { sessions: 2, terminals: 0 }, confirm: false })
    await settle()
    const event = preventable()

    power.emit("shutdown", event)
    await settle()

    expect(event.prevented()).toBe(true)
    expect(confirms).toEqual([])
    expect(exits).toEqual(["stop"])
    expect(quit()).toBe(true)
  })

  test("a Windows session end stops the daemon without asking and lets the window close", async () => {
    const { win, exits, confirms, quit } = lifecycle({ platform: "win32", work: { sessions: 1, terminals: 0 }, confirm: false })
    let closed = false
    win.on("closed", () => { closed = true })

    win.emit("query-session-end")
    win.close()
    await settle()

    expect(confirms).toEqual([])
    expect(exits).toEqual(["stop"])
    expect(quit()).toBe(true)
    expect(closed).toBe(true)
  })

  test("a session ending while the quit confirmation is open closes it and stops once", async () => {
    const { app, power, exits, confirms, aborted, quit } = lifecycle({ work: { sessions: 1, terminals: 0 }, confirm: "pending" })
    await settle()

    app.quit()
    await settle()
    expect(confirms).toHaveLength(1)
    power.emit("shutdown", preventable())
    await settle()

    expect(aborted).toEqual([true])
    expect(exits).toEqual(["stop"])
    expect(quit()).toBe(true)
  })
})
