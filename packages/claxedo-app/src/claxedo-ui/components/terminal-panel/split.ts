import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import type { useTerminal } from "@/context/terminal"
import type { useClaxedoLayout } from "../../context/claxedo-layout"
import type { TerminalActionOrigin } from "../../context/claxedo-layout/types"

type Deps = {
  claxedo: ReturnType<typeof useClaxedoLayout>
  terminal: ReturnType<typeof useTerminal>
  ptys: Accessor<Array<{ id: string }>>
  tabId: string
  log: (...args: unknown[]) => void
  resolveLiveFocus: (tabId: string | undefined) => string | undefined
  terminalOrigin: () => TerminalActionOrigin
}

export function createTerminalPanelSplit(deps: Deps) {
  const [splitPending, setSplitPending] = createSignal<
    | {
        at: string
        dir: "h" | "v"
        known: ReadonlySet<string>
      }
    | undefined
  >()
  let splitTimer: ReturnType<typeof setTimeout> | undefined

  onCleanup(() => {
    if (splitTimer) clearTimeout(splitTimer)
  })

  createEffect(() => {
    const req = splitPending()
    if (!req) return
    const all = deps.ptys()
    const next = all.find((pty) => !req.known.has(pty.id))
    if (!next) return

    deps.log("split target arrived", { id: next.id, at: req.at, dir: req.dir })
    const root = deps.resolveLiveFocus(deps.tabId) ?? deps.claxedo.terminal.ids(deps.tabId)[0]
    if (!root) return

    deps.claxedo.terminal.ensure(deps.tabId, root)
    deps.claxedo.terminal.own(deps.tabId, next.id)
    deps.claxedo.terminal.splitInTab({
      tab: deps.tabId,
      at: req.at,
      id: next.id,
      dir: req.dir,
      origin: deps.terminalOrigin(),
    })

    if (splitTimer) {
      clearTimeout(splitTimer)
      splitTimer = undefined
    }
    setSplitPending(undefined)
    setTimeout(() => window.dispatchEvent(new Event("opencode:terminal-fit")), 150)
  })

  const splitFor = (dir: "h" | "v", at: string) => {
    const ids = deps.claxedo.terminal.ids(deps.tabId)
    const root = deps.resolveLiveFocus(deps.tabId) ?? ids[0]
    if (!root) return
    const target = ids.includes(at) ? at : (ids[0] ?? at)

    if (splitTimer) clearTimeout(splitTimer)
    splitTimer = setTimeout(() => {
      if (splitPending()?.at !== target) return
      setSplitPending(undefined)
      splitTimer = undefined
    }, 5000)
    setSplitPending({ at: target, dir, known: new Set(deps.ptys().map((pty) => pty.id)) })

    deps.terminal.new()
  }

  return {
    splitPending,
    splitFor,
  }
}
