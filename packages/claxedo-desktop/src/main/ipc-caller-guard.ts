/**
 * Who is allowed to call the main process.
 *
 * `navigation-guard.ts` explains why the bridge is worth protecting: the
 * preload runs on every document its webContents loads, and the bridge reaches
 * `execFile`. That guard keeps the main window on the app document, which is
 * the right first control. This is the second one, and it exists because of
 * what Unit 6 adds: once Electron main holds the account credential, an IPC
 * caller is not merely running commands as the user — it is SPENDING an account.
 *
 * Depth matters here in a way it usually does not. The navigation guard is a
 * policy over URLs, and every bypass of it (an `about:blank` window that
 * inherits webPreferences, a subframe, a webview whose attributes were not
 * stripped, a future surface someone wires without reading that file) ends at
 * the same `ipcMain` handlers. Checking the SENDER instead of the destination
 * catches all of those with one rule.
 *
 * The rule: a call must come from the top frame of a webContents we ourselves
 * registered as the main renderer. Not "a trusted URL" — a trusted OBJECT.
 * URLs can be spoofed within a compromised renderer; a webContents id cannot be
 * chosen by page content.
 *
 * Kept free of electron VALUE imports so the policy is directly testable, same
 * split as `navigation-guard.ts` and `renderer-origin.ts`.
 */

import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"

/** The parts of an IPC event this policy reads. */
export type IpcCaller = {
  /** `event.sender.id` — the calling webContents. */
  senderId: number
  /**
   * Whether `event.senderFrame` is the webContents' top frame.
   *
   * A subframe is never trusted even inside the main window: an iframe of a
   * remote page shares its parent's webContents id, so the id alone would let
   * embedded content inherit the whole bridge.
   */
  isMainFrame: boolean
}

export type IpcCallerVerdict = { allowed: true } | { allowed: false; reason: string }

/**
 * The set of webContents allowed to call in.
 *
 * Registration is explicit and revocable rather than derived, because "which
 * window is the main one" is knowledge the window code has and this module
 * should not re-derive. Revocation on destroy matters: Electron reuses
 * webContents ids, so a stale entry would eventually grant the bridge to an
 * unrelated future surface.
 */
export function createIpcCallerGuard() {
  const trusted = new Set<number>()

  return {
    trust(senderId: number) {
      trusted.add(senderId)
    },
    revoke(senderId: number) {
      trusted.delete(senderId)
    },
    /** Exposed for assertions; not part of the decision path. */
    trustedCount() {
      return trusted.size
    },
    check(caller: IpcCaller): IpcCallerVerdict {
      if (!trusted.has(caller.senderId)) {
        return { allowed: false, reason: `ipc from untrusted webContents ${caller.senderId}` }
      }
      if (!caller.isMainFrame) {
        return { allowed: false, reason: `ipc from a subframe of webContents ${caller.senderId}` }
      }
      return { allowed: true }
    },
  }
}

export type IpcCallerGuard = ReturnType<typeof createIpcCallerGuard>

/**
 * The `ipcMain` surface this installer wraps.
 *
 * Uses Electron's own event types so the wrapper cannot drift from what it is
 * replacing, while staying structural enough for a fake. The import is
 * TYPE-ONLY and erases,
 * which keeps this module loadable outside an Electron process — the same
 * property `navigation-guard.ts` and `renderer-origin.ts` rely on to stay
 * directly testable.
 */
export type GuardableIpcMain = {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): unknown
  on(channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void): unknown
}

/**
 * Wrap every registration so no handler can forget the check.
 *
 * Deliberately central rather than a per-handler helper. There are 60-odd
 * channels; a helper each one must remember to call is a control that works
 * until the next handler, and the handler that forgets will be the interesting
 * one. Wrapping `handle`/`on` themselves makes the guard the default and
 * omission impossible.
 *
 * Must be installed BEFORE handlers register: it works by replacing these two
 * methods, so anything registered earlier keeps the unwrapped originals and is
 * permanently unguarded. `ipc-caller-guard.wiring.test.ts` pins that ordering
 * in the real entry.
 */
export function installIpcCallerGuard(input: {
  ipcMain: GuardableIpcMain
  guard: IpcCallerGuard
  readCaller: (event: unknown) => IpcCaller
  onRejected?: (channel: string, reason: string) => void
}) {
  const { ipcMain, guard, readCaller, onRejected } = input
  const originalHandle = ipcMain.handle.bind(ipcMain)
  const originalOn = ipcMain.on.bind(ipcMain)
  let guarded = 0

  const reject = (channel: string, reason: string) => {
    onRejected?.(channel, reason)
    // Thrown, not silently dropped. An invoke() that hangs forever is a bug
    // report about a broken feature; one that rejects is a security event with
    // a stack.
    return new Error(`ipc "${channel}" rejected: ${reason}`)
  }

  ipcMain.handle = (channel, listener) => {
    guarded++
    return originalHandle(channel, ((event: unknown, ...args: never[]) => {
      const verdict = guard.check(readCaller(event))
      if (!verdict.allowed) throw reject(channel, verdict.reason)
      return (listener as (event: unknown, ...args: never[]) => unknown)(event, ...args)
    }) as never)
  }

  ipcMain.on = (channel, listener) => {
    guarded++
    // Returned, not discarded: `ipcMain.on` is EventEmitter-chainable.
    return originalOn(channel, ((event: unknown, ...args: never[]) => {
      const verdict = guard.check(readCaller(event))
      if (!verdict.allowed) {
        onRejected?.(channel, verdict.reason)
        // A fire-and-forget `send` has no channel to reject on, so dropping is
        // the only available answer; the report above is what makes it visible.
        return
      }
      ;(listener as (event: unknown, ...args: never[]) => void)(event, ...args)
    }) as never)
  }

  return { guardedCount: () => guarded }
}

/**
 * The process-wide guard.
 *
 * A singleton because `ipcMain` is one, and because the alternative — threading
 * an instance from the entry through window creation — is a parameter every
 * future window author can decline to pass.
 */
let processGuard: IpcCallerGuard | undefined
export function mainIpcCallerGuard(): IpcCallerGuard {
  return (processGuard ??= createIpcCallerGuard())
}

/**
 * Trust a window that carries the preload bridge, for exactly as long as it
 * exists.
 *
 * Called beside `wireNavigationGuard` at each window's construction rather than
 * from the entry, so trust is granted by the same code that grants the bridge.
 * A window that gets a preload and is not trusted here would simply not work,
 * which is the failure direction to prefer.
 */
export function trustWindowWithBridge(input: {
  webContentsId: number
  onDestroyed: (listener: () => void) => void
  guard?: IpcCallerGuard
}) {
  const guard = input.guard ?? mainIpcCallerGuard()
  guard.trust(input.webContentsId)
  // Electron reuses webContents ids, so an id left trusted after its window
  // dies eventually names something else entirely.
  input.onDestroyed(() => guard.revoke(input.webContentsId))
}
