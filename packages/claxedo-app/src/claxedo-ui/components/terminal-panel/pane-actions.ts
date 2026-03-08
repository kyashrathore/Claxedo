import type { Accessor } from "solid-js"
import type { useClaxedoLayout } from "../../context/claxedo-layout"

type Deps = {
  claxedo: ReturnType<typeof useClaxedoLayout>
  tabs: Accessor<ReturnType<ReturnType<typeof useClaxedoLayout>["groupTabs"]>>
  map: Accessor<Map<string, { title?: string }>>
  tabId: string
  directory: string
  resolveLiveFocus: (tabId: string | undefined) => string | undefined
  closePty: (id: string) => void
  terminalOrigin: () => {
    tabId: string
    groupId: string
    hostId: string
  }
}

export function createTerminalPaneActions(deps: Deps) {
  const closePane = (id: string) => {
    const root = deps.resolveLiveFocus(deps.tabId)
    if (!root) return
    const origin = deps.terminalOrigin()

    deps.closePty(id)

    if (id === root) {
      const next = deps.claxedo.terminal.ids(deps.tabId).find((x) => x !== id)
      if (next) {
        const title = deps.map().get(next)?.title
        deps.tabs().patch(deps.tabId, { terminalId: next, title: title ?? "Terminal" })
        deps.claxedo.terminal.disown(next)
        deps.claxedo.terminal.closeInTab({ tab: deps.tabId, id, origin })
        deps.claxedo.terminal.focusInTab({ tab: deps.tabId, id: next, origin })
        return
      }
      deps.claxedo.terminal.closeInTab({ tab: deps.tabId, id, origin })
      deps.claxedo.terminal.disown(id)
      deps.claxedo.terminal.clear(deps.tabId)
      deps.tabs().close(deps.tabId)
      return
    }

    deps.claxedo.terminal.closeInTab({ tab: deps.tabId, id, origin })
    deps.claxedo.terminal.disown(id)
  }

  const detachPane = (id: string) => {
    const pty = deps.map().get(id)
    if (!pty) return
    const origin = deps.terminalOrigin()
    deps.claxedo.terminal.detachFromTab({ tab: deps.tabId, id, origin })
    const created = deps.tabs().addTerminal(deps.directory, id, pty.title ?? "Terminal")
    if (created) deps.tabs().setActive(created)
  }

  const focusPane = (id: string) => {
    deps.claxedo.terminal.focusInTab({ tab: deps.tabId, id, origin: deps.terminalOrigin() })
    window.dispatchEvent(new Event("opencode:terminal-fit"))
  }

  const zoomPane = (id: string) => {
    deps.claxedo.terminal.zoomInTab({ tab: deps.tabId, id, origin: deps.terminalOrigin() })
  }

  return {
    closePane,
    detachPane,
    focusPane,
    zoomPane,
  }
}
