import { quitConfirmMessage, type RunningWork } from "./daemon-quit"

/**
 * - `quit`: the user quit (Cmd+Q, a Quit menu item, the tray, install on quit).
 *   Running work is confirmed, then the daemon is stopped.
 * - `stop`: the same stop without asking, for a quit nobody is there to answer
 *   (a signal, an OS logout, restart or shutdown). It also closes a quit
 *   confirmation that is already showing.
 * - `handoff`: a same-build restart. Only this app's lease is released and the
 *   relaunched app adopts the daemon with its work still running.
 */
export type ExitIntent = "quit" | "stop" | "handoff"

const WORK_DEADLINE_MS = 3_000

type Preventable = { preventDefault: () => void }

/** The slice of Electron's `app` this module drives. */
export type LifecycleApp = {
  on(event: "before-quit", listener: (event: Preventable) => void): unknown
  on(event: "window-all-closed" | "activate", listener: () => void): unknown
  on(event: "second-instance", listener: (event: unknown, argv: string[]) => void): unknown
  on(event: "open-url", listener: (event: Preventable, url: string) => void): unknown
  quit: () => void
}

/** The slice of Electron's `powerMonitor` this module drives. */
export type LifecyclePowerMonitor = {
  on(event: "shutdown", listener: (event?: Preventable) => void): unknown
  on(event: "suspend" | "resume", listener: () => void): unknown
}

/** The slice of a `BrowserWindow` this module drives. */
export type LifecycleWindow = {
  on(event: "close", listener: (event: Preventable) => void): unknown
  on(event: "query-session-end" | "session-end", listener: () => void): unknown
  hide: () => void
  show: () => void
  focus: () => void
  isDestroyed: () => boolean
}

/**
 * Closing the window keeps Claxedo running in the background; quitting stops
 * the daemon and everything it runs. macOS reopens the window from the Dock;
 * other platforms from the tray, which also offers Quit.
 */
export function createAppLifecycle(input: {
  app: LifecycleApp
  powerMonitor: () => LifecyclePowerMonitor
  platform: NodeJS.Platform
  window: () => LifecycleWindow | undefined
  ready: Promise<unknown>
  createTray: (actions: { open: () => void; quit: () => void }) => void
  deepLinks: (urls: string[]) => void
  runningWork: () => Promise<RunningWork | undefined>
  workDeadlineMs?: number
  confirmQuit: (message: string, signal: AbortSignal) => Promise<boolean>
  exit: (intent: ExitIntent) => Promise<void>
  log: (message: string, fields?: Record<string, unknown>) => void
}) {
  let exiting: Promise<void> | undefined
  let exited = false
  let deciding = false
  let confirming: AbortController | undefined

  const open = () => {
    const win = input.window()
    if (!win || win.isDestroyed()) return
    win.show()
    win.focus()
  }

  /**
   * A daemon that is gone or wedged cannot say what is running, and must not
   * keep the app from quitting: past the deadline, or on an error, there is
   * nothing to confirm and the quit goes on to stop it.
   */
  const workToConfirm = async (): Promise<RunningWork | undefined> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<"late">((resolve) => { timer = setTimeout(resolve, input.workDeadlineMs ?? WORK_DEADLINE_MS, "late") })
    try {
      const work = await Promise.race([input.runningWork(), deadline])
      if (work !== "late") return work
      input.log("the daemon did not report its running work in time; quitting without asking")
    } catch (error) {
      input.log("the daemon's running work could not be read; quitting without asking", { error: String(error) })
    } finally {
      clearTimeout(timer)
    }
    return undefined
  }

  const confirmed = async (work: RunningWork | undefined) => {
    const message = work && quitConfirmMessage(work)
    if (!message || exiting) return true
    confirming = new AbortController()
    try {
      return await input.confirmQuit(message, confirming.signal)
    } catch (error) {
      input.log("the quit confirmation failed; quitting", { error: String(error) })
      return true
    }
  }

  /**
   * Decides, then runs `then` (normally `app.quit()`) once the exit has done
   * its work. A request made while an exit is running waits for that exit and
   * leaves the quit to its `then`. Answers whether it exits.
   */
  const requestExit = async (intent: ExitIntent, then: () => void): Promise<boolean> => {
    if (exiting) {
      await exiting
      return true
    }
    if (intent === "quit") {
      if (deciding) return false
      deciding = true
      try {
        const work = await workToConfirm()
        if (!(await confirmed(work)) && !exiting) {
          input.log("quit cancelled", { ...work })
          return false
        }
      } finally {
        deciding = false
        confirming = undefined
      }
      if (exiting) {
        await exiting
        return false
      }
    }
    confirming?.abort()
    input.log("app exiting", { intent })
    exiting = input.exit(intent)
      .catch((error: unknown) => input.log("the exit did not complete", { intent, error: String(error) }))
      .finally(() => { exited = true })
    await exiting
    then()
    return true
  }

  const unattended = (reason: string) => {
    input.log("the OS is ending the session; quitting without asking", { reason })
    void requestExit("stop", () => input.app.quit())
  }

  input.app.on("before-quit", (event) => {
    if (exited) return
    event.preventDefault()
    void requestExit("quit", () => input.app.quit())
  })
  input.app.on("window-all-closed", () => input.log("all windows closed; Claxedo keeps running"))
  input.app.on("activate", open)
  input.app.on("second-instance", (_event, argv) => {
    const urls = argv.filter((arg) => arg.startsWith("claxedo://"))
    if (urls.length) input.deepLinks(urls)
    open()
  })
  // macOS delivers a link to a running app here, with no `activate`.
  input.app.on("open-url", (event, url) => {
    event.preventDefault()
    input.deepLinks([url])
    open()
  })
  // `powerMonitor` and `Tray` are unusable before the app is ready.
  void input.ready.then(() => {
    const power = input.powerMonitor()
    power.on("suspend", () => input.log("system suspending"))
    power.on("resume", () => input.log("system resumed"))
    // Holding the shutdown lets the daemon stop before the OS ends the session.
    power.on("shutdown", (event) => {
      event?.preventDefault()
      unattended("shutdown")
    })
    if (input.platform !== "darwin") input.createTray({ open, quit: () => input.app.quit() })
  })

  return {
    quitting: () => exiting !== undefined,
    open,
    requestExit,
    /** Hides instead of closing until an exit is approved, so the renderer keeps its state. */
    keepOnClose(win: LifecycleWindow) {
      win.on("close", (event) => {
        if (exiting) return
        event.preventDefault()
        win.hide()
      })
      win.on("query-session-end", () => unattended("query-session-end"))
      win.on("session-end", () => unattended("session-end"))
    },
  }
}
