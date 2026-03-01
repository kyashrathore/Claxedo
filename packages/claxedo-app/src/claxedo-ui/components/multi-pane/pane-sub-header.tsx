/**
 * PaneSubHeader
 *
 * Horizontal bar showing:
 * - Named layout presets (switchable, renamable, deletable)
 * - Add-pane buttons: Session (+), Claude (C), Codex (X), Terminal
 *   These split the focused pane and add a new pane with the right content.
 */

import { For, Show, createSignal, createMemo } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { useClaxedoLayout, type PaneContent } from "../../context/claxedo-layout"
import { getTerminalCommands } from "../../../components/settings-terminals"
import { requestTerminalFitOnPaneChange } from "./terminal-fit"

export function PaneSubHeader(props: { tabId: string; directory: string }) {
  const claxedo = useClaxedoLayout()
  const [editingId, setEditingId] = createSignal<string | null>(null)
  const [editValue, setEditValue] = createSignal("")
  const [contextMenuId, setContextMenuId] = createSignal<string | null>(null)
  const [contextMenuPos, setContextMenuPos] = createSignal<{ x: number; y: number } | null>(null)

  const state = createMemo(() => claxedo.multiPane.getState(props.tabId))
  const layouts = createMemo(() => state()?.layouts ?? [])
  const activeId = createMemo(() => state()?.activeLayoutId)
  const hasMultipleLayouts = createMemo(() => layouts().length > 1)

  const getCommands = () => getTerminalCommands()

  /** Get the focused leaf ID (or fallback to first leaf) to split against */
  const splitTarget = () => {
    const layout = claxedo.multiPane.activeLayout(props.tabId)
    if (!layout) return undefined
    return layout.focus ?? claxedo.multiPane.leafIds(props.tabId)[0]
  }

  const addPane = (content: PaneContent) => {
    const at = splitTarget()
    if (!at) return
    claxedo.multiPane.splitLeaf(props.tabId, "v", at, content)
    requestTerminalFitOnPaneChange()
  }

  const addSessionPane = () => {
    const at = splitTarget()
    const source = at ? claxedo.multiPane.getContent(props.tabId, at) : undefined
    const sourceName = source?.intent?.name
    const refs = sourceName ? [sourceName] : undefined
    if (source?.type === "page") {
      addPane({
        type: "session",
        directory: props.directory,
        sessionId: "new",
        intent: {
          name: "chat",
          role: "assistant",
          refs,
          defaults: {
            agent: "doc",
          },
        },
      })
      return
    }
    addPane({
      type: "session",
      directory: props.directory,
      sessionId: "new",
      intent: refs
        ? {
            role: "assistant",
            refs,
          }
        : undefined,
    })
  }

  const addTerminalPane = (command?: string, title?: string) => {
    const pendingId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    addPane({
      type: "terminal",
      directory: props.directory,
      terminalId: pendingId,
      command,
      title: title || "Terminal",
    })
  }

  // Layout management
  const handleAddLayout = () => {
    const count = layouts().length + 1
    claxedo.multiPane.addLayout(props.tabId, `layout ${count}`)
  }

  const handleContextMenu = (e: MouseEvent, layoutId: string) => {
    e.preventDefault()
    setContextMenuId(layoutId)
    setContextMenuPos({ x: e.clientX, y: e.clientY })
  }

  const closeContextMenu = () => {
    setContextMenuId(null)
    setContextMenuPos(null)
  }

  const handleRename = (layoutId: string) => {
    const layout = layouts().find((l) => l.id === layoutId)
    if (!layout) return
    closeContextMenu()
    setEditingId(layoutId)
    setEditValue(layout.name)
  }

  const handleRenameSubmit = () => {
    const id = editingId()
    if (id && editValue().trim()) {
      claxedo.multiPane.renameLayout(props.tabId, id, editValue().trim())
    }
    setEditingId(null)
  }

  const handleDelete = (layoutId: string) => {
    closeContextMenu()
    claxedo.multiPane.removeLayout(props.tabId, layoutId)
  }

  const handleDuplicate = (layoutId: string) => {
    closeContextMenu()
    claxedo.multiPane.duplicateLayout(props.tabId, layoutId)
  }

  return (
    <div class="shrink-0 h-7 flex items-center gap-0 px-1 border-b border-border-weaker-base/50 bg-background-stronger/50 select-none overflow-x-auto">
      {/* Layout tabs — only shown when multiple layouts exist */}
      <Show when={hasMultipleLayouts()}>
        <div class="flex items-center gap-1 mr-1">
          <For each={layouts()}>
            {(layout) => (
              <Show
                when={editingId() === layout.id}
                fallback={
                  <button
                    class="h-5 px-2 rounded text-[11px] font-medium whitespace-nowrap transition-colors"
                    classList={{
                      "bg-background-base text-text-base shadow-sm": activeId() === layout.id,
                      "text-text-weak hover:text-text-base hover:bg-background-base/50": activeId() !== layout.id,
                    }}
                    onClick={() => claxedo.multiPane.setActiveLayout(props.tabId, layout.id)}
                    onContextMenu={(e) => handleContextMenu(e, layout.id)}
                    onDblClick={() => handleRename(layout.id)}
                  >
                    {layout.name}
                  </button>
                }
              >
                <input
                  class="h-5 px-1 rounded text-[11px] font-medium bg-background-base text-text-base outline-none ring-1 ring-border-weak-base w-24"
                  value={editValue()}
                  onInput={(e) => setEditValue(e.currentTarget.value)}
                  onBlur={handleRenameSubmit}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleRenameSubmit()
                    if (e.key === "Escape") setEditingId(null)
                  }}
                  ref={(el) => setTimeout(() => el.focus(), 0)}
                />
              </Show>
            )}
          </For>

          <button
            class="h-5 w-5 flex items-center justify-center rounded text-text-weaker hover:text-text-weak hover:bg-background-base/50 transition-colors"
            onClick={handleAddLayout}
            aria-label="Add layout"
          >
            <Icon name="plus" size="small" />
          </button>
        </div>

        {/* Separator */}
        <div class="w-px h-4 bg-border-weaker-base/50 mx-1" />
      </Show>

      {/* Add-pane buttons — same as top-level tab bar */}
      <div class="flex items-center gap-0">
        <Tooltip value="New Session Pane">
          <button
            type="button"
            class="flex items-center justify-center w-6 h-6 rounded hover:bg-surface-base-hover text-text-weak hover:text-text-base transition-colors shrink-0"
            onClick={addSessionPane}
            aria-label="New Session Pane"
          >
            <Icon name="plus-small" size="small" />
          </button>
        </Tooltip>

        <Tooltip value="New Claude Pane">
          <button
            type="button"
            class="flex items-center justify-center w-6 h-6 rounded hover:bg-surface-base-hover text-text-weak hover:text-text-base transition-colors shrink-0"
            onClick={() => addTerminalPane(getCommands().claude, "Claude")}
            aria-label="New Claude Pane"
          >
            <span class="text-[10px] font-bold">C</span>
          </button>
        </Tooltip>

        <Tooltip value="New Codex Pane">
          <button
            type="button"
            class="flex items-center justify-center w-6 h-6 rounded hover:bg-surface-base-hover text-text-weak hover:text-text-base transition-colors shrink-0"
            onClick={() => addTerminalPane(getCommands().codex, "Codex")}
            aria-label="New Codex Pane"
          >
            <span class="text-[10px] font-bold">X</span>
          </button>
        </Tooltip>

        <Tooltip value="New Terminal Pane">
          <button
            type="button"
            class="flex items-center justify-center w-6 h-6 rounded hover:bg-surface-base-hover text-text-weak hover:text-text-base transition-colors shrink-0"
            onClick={() => addTerminalPane()}
            aria-label="New Terminal Pane"
          >
            <Icon name="console" size="small" />
          </button>
        </Tooltip>

        {/* More dropdown for custom commands */}
        <Show when={getCommands().custom.length > 0}>
          <DropdownMenu>
            <DropdownMenu.Trigger class="flex items-center justify-center w-6 h-6 rounded hover:bg-surface-base-hover text-text-weak hover:text-text-base transition-colors cursor-pointer border-none bg-transparent shrink-0">
              <Icon name="chevron-down" size="small" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content class="z-[200]">
                <For each={getCommands().custom}>
                  {(cmd) => (
                    <Show when={cmd.name && cmd.command}>
                      <DropdownMenu.Item onSelect={() => addTerminalPane(cmd.command, cmd.name)}>
                        <Icon name="console" size="small" class="mr-2" />
                        {cmd.name}
                      </DropdownMenu.Item>
                    </Show>
                  )}
                </For>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu>
        </Show>
      </div>

      {/* Context menu for layout tabs */}
      <Show when={contextMenuPos() && contextMenuId()}>
        {(_) => {
          const pos = contextMenuPos()!
          const menuId = contextMenuId()!
          const canDelete = layouts().length > 1

          const handleClickOutside = () => closeContextMenu()

          return (
            <>
              <div
                class="fixed inset-0 z-50"
                onClick={handleClickOutside}
                onContextMenu={(e) => {
                  e.preventDefault()
                  handleClickOutside()
                }}
              />
              <div
                class="fixed z-50 min-w-32 rounded-md border border-border-weaker-base bg-background-stronger shadow-lg py-1"
                style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
              >
                <button
                  class="w-full px-3 py-1.5 text-left text-[12px] text-text-base hover:bg-background-base transition-colors"
                  onClick={() => handleRename(menuId)}
                >
                  Rename
                </button>
                <button
                  class="w-full px-3 py-1.5 text-left text-[12px] text-text-base hover:bg-background-base transition-colors"
                  onClick={() => handleDuplicate(menuId)}
                >
                  Duplicate
                </button>
                <Show when={canDelete}>
                  <div class="my-1 border-t border-border-weaker-base/50" />
                  <button
                    class="w-full px-3 py-1.5 text-left text-[12px] text-red-400 hover:bg-background-base transition-colors"
                    onClick={() => handleDelete(menuId)}
                  >
                    Delete
                  </button>
                </Show>
              </div>
            </>
          )
        }}
      </Show>
    </div>
  )
}
