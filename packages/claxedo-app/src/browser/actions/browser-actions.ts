import type { useClaxedoLayout } from "../../claxedo-ui/context/claxedo-layout"

type Claxedo = ReturnType<typeof useClaxedoLayout>

export const BROWSER_TAB_DISABLED_TOAST_TITLE =
  "Browser tabs require the desktop app with CLAXEDO_ENABLE_BROWSER_TAB=1"

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

/**
 * Feature-flag-aware wrapper around `openBrowserTab`. Centralizes the
 * browser-tab gating so the hotkey (`use-session-commands.tsx`) and any
 * future call sites share the same toast + short-circuit behavior.
 *
 * - If `enabled` is `false`, emits a toast via `showToast` and returns
 *   `{ ok: false, reason: "disabled" }` without creating a tab.
 * - If `claxedo` is missing (non-claxedo UI mode), same as above.
 * - If `workspaceDir` is missing, emits a different toast and returns
 *   `{ ok: false, reason: "no-workspace" }`.
 * - Otherwise, forwards to `openBrowserTab` and returns `{ ok: true, id }`.
 *
 * Extracted as a pure function so `use-session-commands.test.tsx` can cover
 * the gating contract without spinning up the full session-command harness.
 */
export type OpenBrowserTabResult =
  | { ok: true; id: string | undefined }
  | { ok: false; reason: "disabled" | "no-workspace" }

export function openBrowserTabWithGate(
  input: {
    enabled: boolean
    claxedo: Claxedo | undefined
    workspaceDir: string | undefined
    url?: string
    title?: string
    groupId?: string
  },
  showToast: (opts: { variant: "default"; title: string }) => void,
): OpenBrowserTabResult {
  if (!input.enabled || !input.claxedo) {
    showToast({ variant: "default", title: BROWSER_TAB_DISABLED_TOAST_TITLE })
    return { ok: false, reason: "disabled" }
  }
  if (!input.workspaceDir) {
    showToast({ variant: "default", title: "Open a workspace first to create a browser tab" })
    return { ok: false, reason: "no-workspace" }
  }
  const id = openBrowserTab(input.claxedo, {
    workspaceDir: input.workspaceDir,
    url: input.url,
    title: input.title,
    groupId: input.groupId,
  })
  return { ok: true, id }
}
