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

type Preventable = { preventDefault: () => void }

/** The slice of Electron's `app` this module drives. */
export type LifecycleApp = {
  on(event: "before-quit", listener: (event: Preventable) => void): unknown
  on(event: "window-all-closed" | "activate", listener: () => void): unknown
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
  runningWork: () => Promise<RunningWork | undefined>
  confirmQuit: (message: string, signal: AbortSignal) => Promise<boolean>
  exit: (intent: ExitIntent) => Promise<void>
  log: (message: string, fields?: Record<string, unknown>) => void
}) {
  let approved = false
  let deciding = false
  let confirming: AbortController | undefined

  const open = () => {
    const win = input.window()
    if (!win || win.isDestroyed()) return
    win.show()
    win.focus()
  }

  /** Decides, then runs `then` (normally `app.quit()`) once the exit has done its work. Answers whether it exits. */
  const requestExit = async (intent: ExitIntent, then: () => void): Promise<boolean> => {
    if (approved) {
      then()
      return true
    }
    if (intent === "quit") {
      if (deciding) return false
      deciding = true
      try {
        const work = await input.runningWork()
        const message = work && quitConfirmMessage(work)
        if (message && !approved) {
          confirming = new AbortController()
          const confirmed = await input.confirmQuit(message, confirming.signal)
          if (!confirmed && !approved) {
            input.log("quit cancelled", { ...work })
            return false
          }
        }
      } finally {
        deciding = false
        confirming = undefined
      }
      // An unattended exit that arrived while this one was deciding already ran.
      if (approved) return false
    }
    confirming?.abort()
    approved = true
    input.log("app exiting", { intent })
    try {
      await input.exit(intent)
    } finally {
      then()
    }
    return true
  }

  const unattended = (reason: string) => {
    input.log("the OS is ending the session; quitting without asking", { reason })
    void requestExit("stop", () => input.app.quit())
  }

  input.app.on("before-quit", (event) => {
    if (approved) return
    event.preventDefault()
    void requestExit("quit", () => input.app.quit())
  })
  input.app.on("window-all-closed", () => input.log("all windows closed; Claxedo keeps running"))
  input.app.on("activate", open)
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
    quitting: () => approved,
    open,
    requestExit,
    /** Hides instead of closing until an exit is approved, so the renderer keeps its state. */
    keepOnClose(win: LifecycleWindow) {
      win.on("close", (event) => {
        if (approved) return
        event.preventDefault()
        win.hide()
      })
      win.on("query-session-end", () => unattended("query-session-end"))
      win.on("session-end", () => unattended("session-end"))
    },
  }
}
