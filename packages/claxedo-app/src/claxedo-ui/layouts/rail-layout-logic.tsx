import type { useClaxedoLayout } from "../context/claxedo-layout"
import type { usePlatform } from "@opencode-ai/claxedo-app"
import type { useDialog } from "@opencode-ai/ui/context/dialog"
import type { Component, JSX } from "solid-js"

/**
 * Shared logic for closing a tab or pane, or quitting the app if on desktop and no tabs remain.
 */
export function closeTabLogic(
  claxedo: ReturnType<typeof useClaxedoLayout>,
  platform: ReturnType<typeof usePlatform>,
  dialog: ReturnType<typeof useDialog>,
  components: {
    Dialog: Component<{ title: string; description: string; children: JSX.Element }>,
    Button: Component<{ variant: "ghost" | "primary" | "secondary"; onClick: () => void; children: JSX.Element }>
  }
) {
  const { Dialog, Button } = components
  const focusedId = claxedo.split.focusedId()
  if (!focusedId) return

  // 1. Try closing pane first
  const activeTab = claxedo.groupTabs(focusedId).active()
  if (activeTab) {
    const tabId = activeTab.id
    const layout = claxedo.multiPane.activeLayout(tabId)
    if (layout && layout.focus) {
      const leafIds = claxedo.multiPane.leafIds(tabId)
      if (leafIds.length > 1) {
        claxedo.multiPane.closeLeaf(tabId, layout.focus)
        return
      }
    }
  }

  // 2. Check if we have any tabs left to close
  const allTabs = claxedo.select.visibleGroups().flatMap((g) => claxedo.groupTabs(g.id).items() ?? [])
  if (allTabs.length === 0) {
    if (platform.platform === "desktop") {
      dialog.show(() => (
        <Dialog title="Quit Claxedo?" description="Are you sure you want to quit the application?">
          <div class="flex justify-end gap-2 mt-4">
            <Button variant="ghost" onClick={() => dialog.close()}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void platform.quit?.()}>
              Quit
            </Button>
          </div>
        </Dialog>
      ))
    }
    return
  }

  // 3. Close the active tab
  claxedo.groupTabs(focusedId).closeActive()
}
