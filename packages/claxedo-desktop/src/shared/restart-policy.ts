/**
 * What the "Restart" action means — which is not the same thing in a packaged
 * app as it is in a development run.
 *
 * Packaged: the Electron process is the top of its own process tree, so
 * `app.relaunch()` followed by a quit does exactly what the label promises. The
 * app goes away and comes back by itself.
 *
 * Development: the Electron process is a CHILD of `electron-vite dev` (started
 * by `bun dev:desktop` or `script/onboarding-desktop.sh`), and that parent also
 * owns the renderer's Vite dev server. `app.relaunch()` does still re-exec the
 * Electron binary, but the quit that has to follow it takes the parent pipeline
 * down too — so the relaunched app points at a renderer dev server that no
 * longer exists and comes up blank, when the whole pipeline doesn't simply die.
 * The action reads as "restart" and behaves as "kill my dev server".
 *
 * No in-app action can restart a process tree the app does not own, so the
 * honest development behaviour is a window reload, labelled as a reload. That
 * covers the case people actually hit (a wedged renderer). A wedged MAIN
 * process still needs the terminal, and always will.
 *
 * This module is deliberately free of any `electron` import so the branching is
 * unit-testable; callers pass the real `app`/`webContents` calls in.
 */

export type RestartBehavior = "relaunch" | "reload"

export function restartBehavior(packaged: boolean): RestartBehavior {
  return packaged ? "relaunch" : "reload"
}

/** The label has to describe what the item does, not what we wish it did. */
export function restartMenuLabel(packaged: boolean) {
  return packaged ? "Restart" : "Reload Window"
}

/**
 * Single decision point for every restart entry point — the application menu,
 * the `relaunch` IPC channel the renderer's `platform.restart()` reaches, and
 * anything added later. Routing them all through here is what keeps a new
 * caller from re-introducing the development trap.
 */
export function runRestart(input: {
  packaged: boolean
  relaunch: () => void
  quit: () => void
  reload: () => void
}) {
  if (restartBehavior(input.packaged) === "reload") {
    input.reload()
    return
  }
  input.relaunch()
  input.quit()
}
