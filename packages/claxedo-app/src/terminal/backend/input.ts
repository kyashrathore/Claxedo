import type { Terminal as XTerm } from "@xterm/xterm"
import type { Disposer } from "@/shell"
import { setupKeyboard } from "./keyboard"
import { setupCopy, setupPaste } from "./clipboard"
import { setupDrop } from "./drop"
import { setupWheel } from "./wheel"
import { installInputModeReclaimer } from "./input-mode-reclaimer"
import type { ModeTracker } from "./modes"
import type { TerminalBackendOptions } from "./types"

export function installInput(input: {
  container: HTMLDivElement
  xterm: XTerm
  options: TerminalBackendOptions
  tracker: ModeTracker
  emitData: (data: string) => void
}): Disposer[] {
  const { container, xterm, options, tracker, emitData } = input
  const bracketedPaste = () => tracker.modes().bracketedPaste
  return [
    installInputModeReclaimer(xterm),
    setupWheel(container, tracker, emitData),
    setupKeyboard(xterm, {
      onShiftEnter: () => emitData("\x1b\r"),
      onWrite: emitData,
      onSplitVertical: options.onSplitVertical,
      onSplitHorizontal: options.onSplitHorizontal,
    }),
    setupPaste(xterm, { onWrite: emitData, bracketedPaste }),
    setupCopy(xterm),
    setupDrop(container, { image: options.image, onWrite: emitData, bracketedPaste }),
  ]
}
