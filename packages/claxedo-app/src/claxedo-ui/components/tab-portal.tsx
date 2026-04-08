/**
 * Tab Portal
 *
 * Renders tab content via Portal from directory scope into app-scope tab hosts.
 * This allows tab content to use directory-level providers (SyncProvider, TerminalProvider, etc.)
 * while the tab shell lives in app scope.
 *
 * @see /ARCHITECTURE.md for the directory-scope vs app-scope portal pattern
 */

import { Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, type JSX, type ParentProps } from "solid-js"
import { Portal } from "solid-js/web"
import { getTabHostId } from "./tab-content-area"
import { useClaxedoLayout } from "../context/claxedo-layout"
import { useLayout } from "@opencode-ai/claxedo-app"
import { TabFile, isMarkdownPath } from "./tab-file"
import { TabReview } from "./tab-review"
import { TabContext } from "./tab-context"
import { openMarkdownPageTab } from "../utils/open-markdown-page-tab"
import { useGlobalSDK } from "@opencode-ai/claxedo-app"
import { createDebugLogger } from "../../overrides/utils/debug"

export function TabPortal(props: ParentProps) {
  const claxedo = useClaxedoLayout()
  const layout = useLayout()
  const globalSDK = useGlobalSDK()
  const debug = createDebugLogger("layout.tab-portal", "layout:tab-portal", {
    legacyKey: "opencode.debug.terminal",
  })
  const activeTab = createMemo(() => claxedo.topTabs.active())
  const messagesHidden = createMemo(() => layout.session.panelMode() === 5)
  const hostId = createMemo(() => {
    const tab = activeTab()
    if (!tab?.id) return
    return getTabHostId(tab.id)
  })

  const [host, setHost] = createSignal<HTMLElement | null>(null)
  const snap = () => ({
    activeId: activeTab()?.id ?? null,
    activeType: activeTab()?.type ?? null,
    hostId: hostId() ?? null,
    found: !!host(),
    hasContent: !!content(),
  })

  const content = createMemo<JSX.Element | undefined>(() => {
    const tab = activeTab()
    if (!tab) return

    if (tab.type === "session") {
      return (
        <div
          class="absolute inset-0 overflow-hidden claxedo-session"
          data-panel-mode={messagesHidden() ? "5" : "0"}
        >
          {props.children}
        </div>
      )
    }

    if (tab.type === "review" && tab.sessionId && tab.directory) {
      return (
        <div class="absolute inset-0 overflow-hidden">
          <TabReview
            sessionId={tab.sessionId}
            mode={tab.reviewMode ?? "session"}
            fromRef={tab.reviewFromRef}
            toRef={tab.reviewToRef}
            onViewFile={(path) => {
              const title = path.split("/").at(-1) ?? path
              claxedo.topTabs.addFile(tab.directory!, path, title)
            }}
          />
        </div>
      )
    }

    if (tab.type === "file") {
      if (!tab.filePath) return
      return (
        <div class="absolute inset-0 overflow-hidden">
          <TabFile
            path={tab.filePath}
            onOpenInPageEditor={
              isMarkdownPath(tab.filePath) && tab.directory
                ? () => {
                    void openMarkdownPageTab({
                      directory: tab.directory!,
                      path: tab.filePath!,
                      sdk: globalSDK,
                      tabs: claxedo.topTabs,
                    })
                  }
                : undefined
            }
          />
        </div>
      )
    }

    if (tab.type === "context" && tab.sessionId) {
      return (
        <div class="absolute inset-0 overflow-hidden">
          <TabContext sessionId={tab.sessionId} />
        </div>
      )
    }
  })

  const isDebug = () =>
    typeof localStorage !== "undefined" && localStorage.getItem("opencode.debug.tabs") === "1"

  onMount(() => {
    debug.verbose("portal mount", snap())
  })

  onCleanup(() => {
    debug.log("portal cleanup", snap())
  })

  createEffect(() => {
    const id = hostId()
    if (!id) {
      debug.verbose("host reset", snap())
      setHost(null)
      return
    }

    if (typeof document === "undefined") return

    const state = { alive: true, raf: 0 }
    debug.verbose("host seek", snap())
    const tick = () => {
      if (!state.alive) return
      const elt = document.getElementById(id)
      if (elt) {
        setHost(elt)
        debug.verbose("host found", snap())
        return
      }
      state.raf = requestAnimationFrame(tick)
    }

    setHost(null)
    tick()

    onCleanup(() => {
      state.alive = false
      cancelAnimationFrame(state.raf)
      debug.verbose("host seek cleanup", snap())
    })
  })
  createEffect(
    on(
      () => [activeTab()?.id ?? "", hostId() ?? "", !!host(), !!content()] as const,
      () => {
        debug.verbose("portal state", snap())
      },
      { defer: true },
    ),
  )

  return (
    <>
      <Show when={isDebug()}>
        <Portal>
          <div class="fixed bottom-2 right-2 z-[9999] rounded bg-black/70 text-white/80 text-xs px-2 py-1 font-mono pointer-events-none">
            tab={activeTab()?.id ?? "-"} host={hostId() ?? "-"} found={host() ? "1" : "0"}
          </div>
        </Portal>
      </Show>
      <Show when={host() && content()} keyed>
        {(view) => <Portal mount={host()!}>{view}</Portal>}
      </Show>
    </>
  )
}

// Tab content is created in directory scope and portaled into the active tab host.
