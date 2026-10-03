import { quitConfirmMessage, type RunningWork } from "./daemon-quit"

/**
 * - `quit`: the user quit (Cmd+Q, a Quit menu item, the tray, install on quit).
 *   Running work is confirmed, then the daemon is stopped.
 * - `stop`: the same stop without asking, for a quit nobody is there to answer
 *   (a signal).
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

/** The slice of a `BrowserWindow` this module drives. */
export type LifecycleWindow = {
  on(event: "close", listener: (event: Preventable) => void): unknown
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
  platform: NodeJS.Platform
  window: () => LifecycleWindow | undefined
  ready: Promise<unknown>
  createTray: (actions: { open: () => void; quit: () => void }) => void
  runningWork: () => Promise<RunningWork | undefined>
  confirmQuit: (message: string) => Promise<boolean>
  exit: (intent: ExitIntent) => Promise<void>
  log: (message: string, fields?: Record<string, unknown>) => void
}) {
  let approved = false
  let deciding = false

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
    if (deciding) return false
    deciding = true
    try {
      if (intent === "quit") {
        const work = await input.runningWork()
        const message = work && quitConfirmMessage(work)
        if (message && !(await input.confirmQuit(message))) {
          input.log("quit cancelled", { ...work })
          return false
        }
      }
      approved = true
    } finally {
      deciding = false
    }
    input.log("app exiting", { intent })
    try {
      await input.exit(intent)
    } finally {
      then()
    }
    return true
  }

  input.app.on("before-quit", (event) => {
    if (approved) return
    event.preventDefault()
    void requestExit("quit", () => input.app.quit())
  })
  input.app.on("window-all-closed", () => input.log("all windows closed; Claxedo keeps running"))
  input.app.on("activate", open)
  if (input.platform !== "darwin") void input.ready.then(() => input.createTray({ open, quit: () => input.app.quit() }))

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
    },
  }
}
