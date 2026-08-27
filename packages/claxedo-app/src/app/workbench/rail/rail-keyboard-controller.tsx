import type { Accessor, JSX } from "solid-js"
import type { CommandOption } from "@/app/providers/command"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"

import type { ClaxedoStateApi } from "../state/provider"
import { createRailKeyboardCommands } from "./rail-keyboard-commands"

export function useRailKeyboardController(input: {
  state: ClaxedoStateApi
  command: { register: (provider: () => CommandOption[]) => unknown }
  dialog: {
    show: (render: () => JSX.Element) => unknown
    close: () => unknown
  }
  platform: {
    platform?: string
    quit?: () => unknown
  }
  /**
   * The surfaces in the order the user SEES them — the header tab strip / the
   * compact switcher (`switcherItems`). `mod+<n>` indexes THIS list, not
   * `recentContents()`: recency is a most-recently-used stack, so `mod+1` used
   * to land on whatever surface was touched last and every number shuffled as
   * soon as you switched, which reads as random. Omitted (tests) → the alive
   * content order, which is the same insertion order the tab strip renders.
   */
  surfaceOrder?: Accessor<readonly string[]>
  toggleSidebar: () => void
}) {
  const closeFocusedPane = () => {
    const focusedPaneId = input.state.wb.state.focusedPaneId
    if (!focusedPaneId) return

    if (input.state.wb.selectors.aliveContents().length === 0) {
      if (input.platform.platform === "desktop") {
        input.dialog.show(() => (
          <Dialog title="Quit Claxedo?" description="Are you sure you want to quit the application?">
            <div class="flex justify-end gap-2 mt-4">
              <Button variant="ghost" onClick={() => input.dialog.close()}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => void input.platform.quit?.()}>
                Quit
              </Button>
            </div>
          </Dialog>
        ))
      }
      return
    }

    input.state.layout.closePane(focusedPaneId, { destroyContent: false })
  }

  const orderedSurfaces = (): readonly string[] =>
    input.surfaceOrder?.() ?? input.state.wb.selectors.aliveContents()

  input.command.register(() =>
    createRailKeyboardCommands(
      {
        closeFocusedPane,
        showNextSurface: () => {
          const ids = input.state.wb.selectors.recentContents()
          const current = input.state.wb.selectors.focusedContent()
          const index = ids.findIndex((id) => id === current)
          const next = ids[index + 1] ?? ids[0]
          if (next) input.state.wb.navigation.show(next)
        },
        showPreviousSurface: () => {
          const ids = input.state.wb.selectors.recentContents()
          const current = input.state.wb.selectors.focusedContent()
          const index = ids.findIndex((id) => id === current)
          const previous = ids[index - 1] ?? ids.at(-1)
          if (previous) input.state.wb.navigation.show(previous)
        },
        toggleSidebar: input.toggleSidebar,
        showSurfaceAtIndex: (index) => {
          const contentId = orderedSurfaces()[index]
          if (contentId) input.state.wb.navigation.show(contentId)
        },
        focusSplitLeft: () => {
          const panes = input.state.wb.selectors.visiblePanes()
          const focusedId = input.state.wb.state.focusedPaneId
          const index = panes.findIndex((pane) => pane.id === focusedId)
          if (index > 0) input.state.wb.split.focus(panes[index - 1].id)
        },
        focusSplitRight: () => {
          const panes = input.state.wb.selectors.visiblePanes()
          const focusedId = input.state.wb.state.focusedPaneId
          const index = panes.findIndex((pane) => pane.id === focusedId)
          if (index >= 0 && index < panes.length - 1) input.state.wb.split.focus(panes[index + 1].id)
        },
      },
      { numberedSurfaceShortcuts: input.platform.platform === "desktop" },
    ),
  )
}
