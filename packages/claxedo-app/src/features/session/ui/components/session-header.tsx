// Session titlebar: project search + Share (central/Convex sessions only when signed in).
import { Button } from "@opencode-ai/ui/button"
import { Keybind } from "@opencode-ai/ui/keybind"
import { getFilename } from "@opencode-ai/core/util/path"
import { createMemo, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { useQuery } from "@tanstack/solid-query"
import { useClaxedoState, useCommand, useLayout, useShellQueryOptions as useQueryOptions } from "@/features/session/app-ports"
import { useLanguage } from "@/platform/i18n/provider"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { useSettings } from "@/platform/settings/provider"
import { useAccountPort } from "@/platform/account/account-provider"
import { workspaceKey } from "@/platform/identity/session-ref"
import { useSessionLayout } from "@/features/session/session-layout"
import { SessionPeopleControl } from "@/features/session/ui/components/session-people-control"
import { useSessionParams } from "@/features/session/providers/session-params"
import { createActivePaneProjection } from "@/features/session/store/active-pane-projection"
import { titlebarCenterSlot, titlebarRightSlot } from "@/ui/controls/portal-slot"

export function SessionHeader() {
  const layout = useLayout()
  const command = useCommand()
  const platform = usePlatform()
  const language = useLanguage()
  const settings = useSettings()
  const account = useAccountPort()
  const claxedoState = useClaxedoState()
  const sessionParams = useSessionParams()
  const queryOptions = useQueryOptions()
  const pathQuery = useQuery(() => queryOptions.path(null))
  const { params, directory } = useSessionLayout()
  const paneActive = () => sessionParams.active?.() ?? true

  const projectDirectory = createMemo(() => directory())
  const globalConfigDirectory = createActivePaneProjection<string | undefined>({
    active: paneActive,
    read: () => pathQuery.data?.config,
    initial: undefined,
  })
  const globalRoot = createMemo(() => {
    const dir = globalConfigDirectory()
    return dir ? `${dir}/global-sessions` : ""
  })
  const globalSession = createMemo(() => {
    const dir = projectDirectory()
    const root = globalRoot()
    if (!dir || !root || !dir.startsWith(root)) return false
    return true
  })
  const readProject = () => {
    if (globalSession()) return
    const directory = projectDirectory()
    if (!directory) return
    return layout.projects.list().find((p) => p.worktree === directory || p.sandboxes?.includes(directory))
  }
  const project = createActivePaneProjection({
    active: paneActive,
    initial: undefined as ReturnType<typeof readProject>,
    read: readProject,
  })
  const name = createMemo(() => {
    if (globalSession()) return "Global Chat"
    const current = project()
    if (current) return current.name || getFilename(current.worktree)
    return getFilename(projectDirectory())
  })

  /**
   * Session sharing is authority-owned for every signed workspace, regardless
   * of whether transcript traffic is hosted centrally or by the workspace.
   * Unsigned/local-only sessions remain unshareable, and the workspace id must
   * come from the canonical SessionRef rather than being inferred from a path.
   */
  const shareTarget = createMemo(() => {
    if (account.state().status !== "signed") return undefined
    const sessionId = params.id
    if (!sessionId || sessionId === "new") return undefined
    const surfaceId = sessionParams.surfaceId?.()
    if (!surfaceId) return undefined
    const content = claxedoState.meta.get(surfaceId)?.content
    const sessionRef = content?.type === "session" ? content.sessionRef : undefined
    if (!sessionRef) return undefined
    const workspaceId = workspaceKey(sessionRef) ?? sessionRef.workspaceId
    if (!workspaceId) return undefined
    return { sessionId, workspaceId }
  })

  const hotkey = createMemo(() => command.keybind("file.open"))
  const isDesktopBeta = platform.platform === "desktop" && import.meta.env.VITE_OPENCODE_CHANNEL === "beta"
  const search = createMemo(() => !isDesktopBeta || settings.general.showSearch())

  const centerMount = titlebarCenterSlot
  const rightMount = titlebarRightSlot

  return (
    <>
      <Show when={paneActive() ? search() && centerMount() : false}>
        {(mount) => (
          <Portal mount={mount()}>
            <Button
              type="button"
              variant="ghost"
              size="small"
              class="hidden md:flex w-[240px] max-w-full min-w-0 items-center gap-2 justify-between rounded-md border border-border-weak-base bg-surface-base shadow-none cursor-default"
              onClick={() => command.trigger("file.open")}
              aria-label={language.t("session.header.searchFiles")}
            >
              <div class="flex min-w-0 flex-1 items-center overflow-visible">
                <span class="flex-1 min-w-0 text-12-regular text-text-weak truncate text-left">
                  {language.t("session.header.search.placeholder", {
                    project: name(),
                  })}
                </span>
              </div>

              <Show when={hotkey()}>
                {(keybind) => (
                  <Keybind class="shrink-0 !border-0 !bg-transparent !shadow-none px-0 text-text-weaker">
                    {keybind()}
                  </Keybind>
                )}
              </Show>
            </Button>
          </Portal>
        )}
      </Show>
      <Show when={paneActive() ? rightMount() : false}>
        {(mount) => (
          <Portal mount={mount()}>
            <div class="flex items-center gap-1">
              <Show when={shareTarget()} keyed>
                {(target) => (
                  <SessionPeopleControl
                    sessionId={target.sessionId}
                    workspaceId={target.workspaceId}
                  />
                )}
              </Show>
            </div>
          </Portal>
        )}
      </Show>
    </>
  )
}
