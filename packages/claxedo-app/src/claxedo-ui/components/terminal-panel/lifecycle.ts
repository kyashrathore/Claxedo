import { untrack } from "solid-js"
import type { useTerminal, LocalPTY } from "@/context/terminal"
import type { useClaxedoLayout } from "../../context/claxedo-layout"
import type { TerminalActionOrigin } from "../../context/claxedo-layout/types"

type Deps = {
  claxedo: ReturnType<typeof useClaxedoLayout>
  terminal: ReturnType<typeof useTerminal>
  map: () => Map<string, LocalPTY>
  tabId: string
  groupId: string
  tabExists: () => boolean
}

export function createTerminalPanelLifecycle(deps: Deps) {
  const isUsablePtyId = (id: string | undefined) => {
    if (!id) return false
    if (id.startsWith("pending-")) return false
    if (deps.map().has(id)) return true
    const lifecycle = deps.claxedo.terminal.lifecycle?.(id)
    if (lifecycle === "creating" || lifecycle === "attaching") return true
    return false
  }

  const closePty = (id: string) => {
    if (id.startsWith("pending-")) {
      deps.claxedo.terminal.disown(id)
      deps.claxedo.terminal.clearClosing?.(id)
      deps.claxedo.terminal.transitionLifecycle?.(id, "closed", "skip_close_pending")
      return
    }
    if (deps.claxedo.terminal.isClosing?.(id)) return
    if (deps.claxedo.terminal.lifecycle?.(id) === "closed") return
    deps.claxedo.terminal.beginClosing?.(id)
    void deps.terminal.close(id)
  }

  const persistUpdate = (pty: Partial<LocalPTY> & { id: string }) => {
    const skip = untrack(() => {
      if (pty.id.startsWith("pending-")) return true
      if (deps.claxedo.terminal.isClosing?.(pty.id)) return true
      const lifecycle = deps.claxedo.terminal.lifecycle?.(pty.id)
      if (lifecycle === "closing" || lifecycle === "closed") return true
      if (!deps.tabExists()) return true
      return false
    })
    if (skip) return

    const { id, title, rows, cols, ...rest } = pty
    deps.terminal.update({ id, ...rest })
  }

  const resolveLiveFocus = (tabId: string | undefined) => {
    if (!tabId) return
    const ids = deps.claxedo.terminal.ids(tabId)
    if (ids.length === 0) return
    const focus = deps.claxedo.terminal.focus(tabId)
    if (focus && ids.includes(focus) && deps.map().has(focus)) return focus
    return ids.find((id) => deps.map().has(id)) ?? ids[0]
  }

  const terminalOrigin = (): TerminalActionOrigin => ({
    tabId: deps.tabId,
    groupId: deps.groupId,
    hostId: `claxedo-tab-host-${deps.tabId}`,
  })

  return {
    isUsablePtyId,
    closePty,
    persistUpdate,
    resolveLiveFocus,
    terminalOrigin,
  }
}
