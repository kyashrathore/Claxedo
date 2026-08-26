import { createSignal, flush, onCleanup } from "solid-js"

const SHELL_MOTION_MS = 120

export function createWorkspacePanelMotionState(input: {
  initialOpen: boolean
}) {
  const [visualOpen, setVisualOpen] = createSignal(input.initialOpen)
  const [bridgeChromeVisible, setBridgeChromeVisible] = createSignal(false)
  let visualOpenValue = input.initialOpen
  let visualOverride: boolean | undefined
  let bridgeChromeTimer: ReturnType<typeof setTimeout> | undefined

  const setVisualPhase = (open: boolean) => {
    visualOverride = open
    visualOpenValue = open
    if (bridgeChromeTimer) clearTimeout(bridgeChromeTimer)
    // This is the imperative click boundary that must expose the new shell
    // state before the handler returns. Flush the single reactive owner so JSX
    // updates the shell, workbench margin, chrome, pointer state, and ARIA
    // together; no second DOM-mutation path is allowed to race the renderer.
    flush(() => {
      setBridgeChromeVisible(true)
      setVisualOpen(open)
    })

    if (open) {
      bridgeChromeTimer = setTimeout(() => {
        setBridgeChromeVisible(false)
        bridgeChromeTimer = undefined
      }, SHELL_MOTION_MS + 20)
      return
    }

    bridgeChromeTimer = undefined
  }

  const reconcileCommittedOpen = (committedOpen: boolean) => {
    const hadVisualOverride = visualOverride !== undefined
    if (visualOverride !== undefined) {
      if (committedOpen === visualOverride) visualOverride = undefined
      else return false
    }

    const authoritativeVisualChange = !hadVisualOverride && committedOpen !== visualOpenValue
    // An authoritative visual transition that did not originate from
    // setVisualPhase has no motion bridge to preserve. Reset any bridge left
    // by an earlier close before opening so floating and panel chrome cannot
    // coexist. Repeated reconciliation must not shorten an active bridge.
    if (authoritativeVisualChange) {
      if (bridgeChromeTimer) clearTimeout(bridgeChromeTimer)
      bridgeChromeTimer = undefined
      setBridgeChromeVisible(false)
    }
    visualOpenValue = committedOpen
    setVisualOpen(committedOpen)
    return true
  }

  onCleanup(() => {
    if (bridgeChromeTimer) clearTimeout(bridgeChromeTimer)
  })

  return {
    bridgeChromeVisible,
    reconcileCommittedOpen,
    setVisualPhase,
    visualOpen,
    visualOpenValue: () => visualOpenValue,
  }
}
