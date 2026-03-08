import { For, Show, createMemo, type Accessor, type JSX } from "solid-js"
import { Terminal } from "@/components/terminal"
import { showToast } from "@opencode-ai/ui/toast"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon } from "@opencode-ai/ui/icon"
import { WebSocketCloseError } from "../../../overrides/components/terminal-connection"
import type { useTerminal, LocalPTY } from "@/context/terminal"
import type { useClaxedoLayout } from "../../context/claxedo-layout"
import type { Pane } from "../../context/claxedo-layout/types"
import type { useSDK } from "@/context/sdk"
import { isMarkdownPath, openMarkdownPageTab } from "../../utils/open-markdown-page-tab"
import {
  computeLeafRects,
  computeSplitHandles,
  paneLeafIds,
  type LeafRect,
  type SplitHandle,
} from "../terminal-pane-layout"

type GroupTabs = ReturnType<ReturnType<typeof useClaxedoLayout>["groupTabs"]>

type Deps = {
  props: {
    tabId: string
    directory: string
  }
  sdk: ReturnType<typeof useSDK>
  claxedo: ReturnType<typeof useClaxedoLayout>
  terminal: ReturnType<typeof useTerminal>
  tabs: Accessor<GroupTabs>
  paneRoot: Accessor<Pane | undefined>
  map: Accessor<Map<string, LocalPTY>>
  splitPending: Accessor<
    | {
        at: string
        dir: "h" | "v"
        known: ReadonlySet<string>
      }
    | undefined
  >
  splitFor: (dir: "h" | "v", at: string) => void
  closePane: (id: string) => void
  detachPane: (id: string) => void
  focusPane: (id: string) => void
  persistUpdate: (pty: Partial<LocalPTY> & { id: string }) => void
  moveState: Accessor<{ id: string } | undefined>
  overState: Accessor<string | undefined>
  startMove: (event: PointerEvent, id: string) => void
  resolveLiveFocus: (tabId: string | undefined) => string | undefined
  log: (...args: unknown[]) => void
}

function EmptyFallback() {
  return (
    <div class="flex size-full items-center justify-center text-text-weak">
      <div class="flex items-center gap-2">
        <Icon name="console" size="small" />
        <span>Terminal not found</span>
      </div>
    </div>
  )
}

export function createTerminalPanelRenderers(deps: Deps) {
  const LeafNode = (leafProps: { id: string }) => {
    const root = () => deps.resolveLiveFocus(deps.props.tabId)
    const zoomed = () => deps.claxedo.terminal.zoom(deps.props.tabId)

    const pty = () => deps.map().get(leafProps.id)
    const active = () => deps.resolveLiveFocus(deps.props.tabId) === leafProps.id
    const dim = () => (zoomed() ? 1 : active() ? 1 : 0.7)
    const pendingDir = () => {
      const req = deps.splitPending()
      if (!req) return undefined
      if (req.at !== leafProps.id) return undefined
      return req.dir
    }
    const pendingV = () => pendingDir() === "v"
    const pendingH = () => pendingDir() === "h"

    const handleConnectError = async (error: unknown) => {
      if (error instanceof WebSocketCloseError && error.code === 1008) {
        const oldId = leafProps.id
        if (oldId.startsWith("pending-")) return
        deps.log("clone-on-reconnect", { oldId, tab: deps.props.tabId })

        let newId: string | undefined
        try {
          newId = await deps.terminal.clone(oldId)
        } catch (e) {
          deps.log("clone-on-reconnect clone failed", {
            oldId,
            tab: deps.props.tabId,
            error: e instanceof Error ? e.message : String(e),
          })
        }

        if (!newId) {
          deps.closePane(oldId)
          return
        }
        deps.log("clone-on-reconnect success", { oldId, newId, tab: deps.props.tabId })
        deps.claxedo.terminal.replaceId(deps.props.tabId, oldId, newId)
        const tab = deps.tabs().items().find((t) => t.id === deps.props.tabId && t.type === "terminal")
        if (tab?.terminalId === oldId) {
          deps.tabs().patch(deps.props.tabId, { terminalId: newId, title: tab.title })
        }
        return
      }
      deps.log("terminal connection failed after retries", {
        id: leafProps.id,
        tab: deps.props.tabId,
        error: error instanceof WebSocketCloseError ? { code: error.code, reason: error.reason } : String(error),
      })
    }

    if (zoomed() && zoomed() !== leafProps.id) return <div class="hidden" />

    return (
      <div
        data-pane={leafProps.id}
        class="group relative size-full min-w-0 min-h-0 overflow-hidden bg-background-base flex flex-col"
        classList={{
          "ring-1 ring-border-weak-base": deps.overState() === leafProps.id,
          "opacity-70": deps.moveState()?.id === leafProps.id,
        }}
        style={{ opacity: String(dim()) }}
        onPointerDown={() => deps.focusPane(leafProps.id)}
      >
        <div class="shrink-0 h-8 flex items-center gap-2 px-2 border-b border-border-weaker-base/50 bg-background-stronger/80 backdrop-blur select-none">
          <div
            class="flex items-center cursor-grab active:cursor-grabbing"
            onPointerDown={(event) => deps.startMove(event, leafProps.id)}
            aria-label="Move pane"
          >
            <Icon name="selector" size="small" class="text-icon-weak" />
          </div>

          <div class="flex items-center gap-2 min-w-0 flex-1">
            <span class="text-[12px] font-medium text-text-weak whitespace-nowrap overflow-hidden text-ellipsis">
              {pty()?.title ?? "Terminal"}
            </span>
          </div>

          <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <div class="relative">
              <IconButton
                icon="layout-right"
                variant="ghost"
                onClick={() => deps.splitFor("v", leafProps.id)}
                aria-label="Split vertical"
                disabled={pendingV()}
                classList={{ "opacity-50": pendingV() }}
              />
              <Show when={pendingV()}>
                <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div class="size-3 rounded-full border-2 border-icon-weak border-t-transparent animate-spin" />
                </div>
              </Show>
            </div>
            <div class="relative">
              <IconButton
                icon="layout-bottom"
                variant="ghost"
                onClick={() => deps.splitFor("h", leafProps.id)}
                aria-label="Split horizontal"
                disabled={pendingH()}
                classList={{ "opacity-50": pendingH() }}
              />
              <Show when={pendingH()}>
                <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div class="size-3 rounded-full border-2 border-icon-weak border-t-transparent animate-spin" />
                </div>
              </Show>
            </div>
            <Show when={root() && leafProps.id !== root()}>
              <IconButton icon="arrow-right" variant="ghost" onClick={() => deps.detachPane(leafProps.id)} aria-label="Move to tab" />
            </Show>
            <IconButton icon="close-small" variant="ghost" onClick={() => deps.closePane(leafProps.id)} aria-label="Close pane" />
          </div>
        </div>

        <Show when={pty()} fallback={<EmptyFallback />}>
          {(p) => {
            const current = p()
            return (
              <div class="flex-1 min-h-0 h-full w-full overflow-hidden">
                <Terminal
                  pty={current}
                  onCleanup={deps.persistUpdate}
                  onUpdate={deps.persistUpdate}
                  onSplitVertical={() => deps.splitFor("v", leafProps.id)}
                  onSplitHorizontal={() => deps.splitFor("h", leafProps.id)}
                  onFileLinkOpen={(filePath) => {
                    const dir = deps.props.directory
                    if (!dir) return
                    if (filePath.startsWith("/") && !filePath.startsWith(dir + "/") && filePath !== dir) {
                      showToast({
                        title: "File outside project",
                        description: `Cannot open files outside the project directory: ${filePath}`,
                        variant: "error",
                      })
                      return
                    }
                    if (isMarkdownPath(filePath)) {
                      void openMarkdownPageTab({
                        directory: dir,
                        path: filePath,
                        sdk: deps.sdk,
                        tabs: deps.tabs(),
                      })
                      return
                    }
                    const title = filePath.split("/").at(-1) ?? filePath
                    const tabId = deps.tabs().addFile(dir, filePath, title)
                    if (tabId) deps.tabs().setActive(tabId)
                  }}
                  onConnectError={handleConnectError}
                />
              </div>
            )
          }}
        </Show>
      </div>
    )
  }

  const FlatPaneRenderer = () => {
    const leafIds = createMemo(() => paneLeafIds(deps.paneRoot()!))

    const rectMap = createMemo(() => {
      const rects = computeLeafRects(deps.paneRoot()!)
      const map = new Map<string, LeafRect>()
      for (const rect of rects) map.set(rect.id, rect)
      return map
    })

    const handles = createMemo(() => computeSplitHandles(deps.paneRoot()!))

    return (
      <div class="relative size-full">
        <For each={leafIds()}>
          {(id) => {
            const rect = () => rectMap().get(id) ?? { top: 0, left: 0, width: 1, height: 1 }
            return (
              <div
                class="absolute overflow-hidden border-b border-l border-r border-border-weaker-base"
                style={{
                  top: `${rect().top * 100}%`,
                  left: `${rect().left * 100}%`,
                  width: `${rect().width * 100}%`,
                  height: `${rect().height * 100}%`,
                }}
              >
                <LeafNode id={id} />
              </div>
            )
          }}
        </For>

        <For each={handles()}>
          {(handle) => (
            <div
              class="absolute z-10"
              style={{
                ...(handle.dir === "v"
                  ? {
                      top: `${handle.top * 100}%`,
                      left: `calc(${handle.left * 100}% - 3px)`,
                      width: "6px",
                      height: `${handle.height * 100}%`,
                      cursor: "col-resize",
                    }
                  : {
                      top: `calc(${handle.top * 100}% - 3px)`,
                      left: `${handle.left * 100}%`,
                      width: `${handle.width * 100}%`,
                      height: "6px",
                      cursor: "row-resize",
                    }),
              }}
              onPointerDown={(event) => {
                const parentRect = (event.currentTarget as HTMLElement).parentElement?.getBoundingClientRect()
                if (!parentRect) return
                const start = handle.dir === "v" ? event.clientX : event.clientY
                const initSize = handle.position
                document.documentElement.dataset.terminalResizeSuspended = "1"

                const move = (e: PointerEvent) => {
                  const delta = (handle.dir === "v" ? e.clientX : e.clientY) - start
                  const span = handle.dir === "v" ? parentRect.width : parentRect.height
                  if (!span) return
                  deps.claxedo.terminal.resize({ tab: deps.props.tabId, path: handle.path, size: initSize + delta / span })
                }

                const up = () => {
                  delete document.documentElement.dataset.terminalResizeSuspended
                  window.dispatchEvent(new Event("opencode:terminal-fit"))
                  window.removeEventListener("pointermove", move)
                  window.removeEventListener("pointerup", up)
                }

                window.addEventListener("pointermove", move)
                window.addEventListener("pointerup", up)
              }}
            />
          )}
        </For>
      </div>
    )
  }

  return {
    FlatPaneRenderer,
    emptyFallback: () => <EmptyFallback />,
  }
}
