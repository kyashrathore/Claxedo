import type { useClaxedoLayout } from "../../claxedo-ui/context/claxedo-layout"

type Claxedo = ReturnType<typeof useClaxedoLayout>

/**
 * Claxedo-owned helper for opening a new browser tab.
 *
 * Lives in `src/browser/` alongside the browser feature's other code, mirroring
 * the `src/shell/`, `src/cloud/runtime/`, `src/session/store/`, `src/pane/store/`
 * layer structure from the 2026-04-13 pane-local-frontend-orchestration plan.
 *
 * Does NOT take the full ActionProps bundle — it only needs the claxedo layout
 * facade. Keeps coupling minimal so this helper can eventually be called from
 * anywhere (hotkey handler, menu, agent tool) without dragging in session-specific
 * action plumbing.
 */
export function openBrowserTab(
  claxedo: Claxedo,
  input: {
    workspaceDir: string
    url?: string
    title?: string
    groupId?: string
  },
): string | undefined {
  const { workspaceDir, url, title, groupId } = input
  if (!workspaceDir) return

  const groups = claxedo.split.groups()
  const focusedId = claxedo.split.focusedId()
  const matches = groups.filter((g) => claxedo.groupWorktree(g.id).default() === workspaceDir)
  const targetGroupId = groupId ?? matches.find((g) => g.id === focusedId)?.id ?? matches[0]?.id ?? focusedId
  const tabs = targetGroupId ? claxedo.groupTabs(targetGroupId) : claxedo.topTabs
  if (targetGroupId) claxedo.dispatch({ type: "SplitFocusRequested", groupId: targetGroupId })

  const id = tabs.addBrowserTab(workspaceDir, url, title)
  if (id) tabs.setActive(id)
  return id
}
