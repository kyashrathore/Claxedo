import { createSignal, onCleanup, onMount } from "solid-js"
import type { useClaxedoLayout } from "../../context/claxedo-layout"

type Deps = {
  tabId: string
  claxedo: ReturnType<typeof useClaxedoLayout>
  resolveLiveFocus: (tabId: string | undefined) => string | undefined
  splitFor: (dir: "h" | "v", at: string) => void
  closePane: (id: string) => void
}

export function createTerminalPanelInteractions(deps: Deps) {
  const [moveState, setMoveState] = createSignal<{ id: string } | undefined>()
  const [overState, setOverState] = createSignal<string | undefined>()

  const startMove = (event: PointerEvent, id: string) => {
    event.preventDefault()
    event.stopPropagation()
    setMoveState({ id })
  }

  onMount(() => {
    const handleMove = (event: PointerEvent) => {
      const m = moveState()
      if (!m) return
      const elt = document.elementFromPoint(event.clientX, event.clientY)
      if (!(elt instanceof HTMLElement)) {
        setOverState(undefined)
        return
      }
      const pane = elt.closest("[data-pane]")
      if (!(pane instanceof HTMLElement)) {
        setOverState(undefined)
        return
      }
      const id = pane.dataset.pane
      if (!id || id === m.id) {
        setOverState(undefined)
        return
      }
      setOverState(id)
    }

    const handleUp = () => {
      const m = moveState()
      const id = overState()
      if (m && id) deps.claxedo.terminal.swap({ tab: deps.tabId, a: m.id, b: id })
      setMoveState(undefined)
      setOverState(undefined)
    }

    window.addEventListener("pointermove", handleMove)
    window.addEventListener("pointerup", handleUp)
    onCleanup(() => {
      window.removeEventListener("pointermove", handleMove)
      window.removeEventListener("pointerup", handleUp)
    })
  })

  onMount(() => {
    const handle = (event: KeyboardEvent) => {
      if ((event as KeyboardEvent & { __claxedoTerminalHandled?: boolean }).__claxedoTerminalHandled) return
      if (!event.metaKey || event.ctrlKey || event.altKey) return
      const key = event.key.toLowerCase()
      if (key !== "w" && key !== "d") return
      const target = event.target instanceof HTMLElement ? event.target : null
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
      const hostId = `claxedo-tab-host-${deps.tabId}`
      const inHost = !!target?.closest(`#${CSS.escape(hostId)}`) || !!active?.closest(`#${CSS.escape(hostId)}`)
      if (!inHost) return
      const inTerminal = !!target?.closest('[data-component="terminal"]') || !!active?.closest('[data-component="terminal"]')
      if (key === "d" && !inTerminal) return
      ;(event as KeyboardEvent & { __claxedoTerminalHandled?: boolean }).__claxedoTerminalHandled = true
      event.preventDefault()
      event.stopImmediatePropagation()
      event.stopPropagation()

      const id = deps.resolveLiveFocus(deps.tabId)
      if (!id) return
      if (key === "d") {
        deps.splitFor(event.shiftKey ? "h" : "v", id)
        return
      }
      deps.closePane(id)
    }

    window.addEventListener("keydown", handle, true)
    onCleanup(() => {
      window.removeEventListener("keydown", handle, true)
    })
  })

  return {
    moveState,
    overState,
    startMove,
  }
}
