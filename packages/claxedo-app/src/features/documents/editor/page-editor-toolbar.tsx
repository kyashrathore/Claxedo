/**
 * Floating selection toolbar for the page editor.
 *
 * Formatting buttons plus the link popover, "turn into" (more) menu, and
 * table tools menu. Receives the Tiptap editor as an accessor and the
 * signals/handlers it needs as props — signals stay owned by
 * PageEditorLoaded. Extracted verbatim from page-editor.tsx (Plan 005);
 * markup, classes, and behavior unchanged.
 */

import { Show, For } from "solid-js"
import type { Editor } from "@tiptap/core"
import {
  FLOATING_TOOLBAR_ITEMS,
  CONVERT_MENU_ITEMS,
  type OverlayEvent,
  type ToolbarItem,
  type ConvertMenuItem,
} from "./page-editor-utils"

export type PageEditorToolbarProps = {
  /** Singleton Tiptap editor owned by PageEditorLoaded — accessor only. */
  editor: () => Editor | undefined
  /** Toolbar anchor when the overlay is in "toolbar" state, else null. */
  visiblePos: () => { x: number; y: number } | null
  tick: () => number
  aiBusy: () => boolean
  aiMenuOpen: () => boolean
  overlayEvent: (event: OverlayEvent) => void
  openAiComposer: () => void
  tableActive: () => boolean
  toolbarPos: () => { x: number; y: number } | null
  computeToolbarPos: () => { x: number; y: number } | null
  getSafeTop: () => number
  scheduleToolbar: (delay?: number) => void
  bumpTick: () => void
  setAiError: (v: string | undefined) => void
  linkMenuOpen: () => boolean
  setLinkMenuOpen: (v: boolean) => void
  linkValue: () => string
  setLinkValue: (v: string) => void
  moreMenuOpen: () => boolean
  setMoreMenuOpen: (open: boolean | ((open: boolean) => boolean)) => void
  tableMenuOpen: () => boolean
  setTableMenuOpen: (open: boolean | ((open: boolean) => boolean)) => void
}

export function PageEditorToolbar(props: PageEditorToolbarProps) {
  let linkInputRef: HTMLInputElement | undefined

  const toggleLinkMenu = () => {
    const t = props.editor()
    if (!t || props.aiBusy()) return
    if (props.linkMenuOpen()) {
      props.setLinkMenuOpen(false)
      return
    }
    const current = t.getAttributes("link").href
    props.setLinkValue(typeof current === "string" ? current : "")
    props.setMoreMenuOpen(false)
    props.setTableMenuOpen(false)
    if (props.aiMenuOpen()) props.overlayEvent({ type: "TOGGLE_AI_MENU" })
    props.setLinkMenuOpen(true)
    setTimeout(() => linkInputRef?.focus(), 0)
  }

  const applyLinkValue = () => {
    const t = props.editor()
    if (!t) return
    const raw = props.linkValue().trim()
    if (!raw) {
      t.chain().focus().extendMarkRange("link").unsetLink().run()
      props.setLinkMenuOpen(false)
      props.bumpTick()
      props.scheduleToolbar(80)
      return
    }
    const href = /^[a-z][a-z\d+\-.]*:|^mailto:|^tel:/i.test(raw) ? raw : `https://${raw}`
    t.chain().focus().extendMarkRange("link").setLink({ href }).run()
    props.setLinkValue(href)
    props.setLinkMenuOpen(false)
    props.bumpTick()
    props.scheduleToolbar(80)
  }

  const runConvertItem = (item: ConvertMenuItem) => {
    const t = props.editor()
    if (!t) return
    item.run(t)
    props.setMoreMenuOpen(false)
    props.setTableMenuOpen(false)
    props.bumpTick()
    props.scheduleToolbar(80)
  }

  const runTableCommand = (
    cmd:
      | "addRowBefore"
      | "addRowAfter"
      | "deleteRow"
      | "addColumnBefore"
      | "addColumnAfter"
      | "deleteColumn"
      | "deleteTable",
  ) => {
    const t = props.editor()
    if (!t) return
    const chain = t.chain().focus()
    if (cmd === "addRowBefore") chain.addRowBefore().run()
    else if (cmd === "addRowAfter") chain.addRowAfter().run()
    else if (cmd === "deleteRow") chain.deleteRow().run()
    else if (cmd === "addColumnBefore") chain.addColumnBefore().run()
    else if (cmd === "addColumnAfter") chain.addColumnAfter().run()
    else if (cmd === "deleteColumn") chain.deleteColumn().run()
    else chain.deleteTable().run()
    if (cmd === "deleteTable") props.setTableMenuOpen(false)
    props.bumpTick()
    props.scheduleToolbar(80)
  }

  const activeMark = (item: Extract<ToolbarItem, { kind: "action" }>) => {
    props.tick()
    const t = props.editor()
    if (!t) return false
    return item.active(t)
  }

  const activeConvert = (item: ConvertMenuItem) => {
    props.tick()
    const t = props.editor()
    if (!t) return false
    return item.active(t)
  }

  const getMoreMenuLayout = () => {
    if (typeof window === "undefined") return { side: "above" as const, maxHeight: 280 }
    const pos = props.toolbarPos() || props.computeToolbarPos()
    if (!pos) return { side: "above" as const, maxHeight: 280 }
    const top = props.getSafeTop()
    const barHeight = 36
    const gap = 8
    const pad = 10
    const above = Math.max(0, Math.floor(pos.y - top - gap))
    const below = Math.max(0, Math.floor(window.innerHeight - (pos.y + barHeight + gap + pad)))
    if (above >= 220 || above >= below)
      return { side: "above" as const, maxHeight: Math.max(140, Math.min(360, above)) }
    return { side: "below" as const, maxHeight: Math.max(140, Math.min(360, below)) }
  }

  const getTableMenuLayout = () => {
    if (typeof window === "undefined") return { side: "above" as const, maxHeight: 280 }
    const pos = props.toolbarPos() || props.computeToolbarPos()
    if (!pos) return { side: "above" as const, maxHeight: 280 }
    const top = props.getSafeTop()
    const barHeight = 36
    const gap = 8
    const pad = 10
    const above = Math.max(0, Math.floor(pos.y - top - gap))
    const below = Math.max(0, Math.floor(window.innerHeight - (pos.y + barHeight + gap + pad)))
    if (above >= 220 || above >= below)
      return { side: "above" as const, maxHeight: Math.max(140, Math.min(320, above)) }
    return { side: "below" as const, maxHeight: Math.max(140, Math.min(320, below)) }
  }

  return (
    <Show when={props.visiblePos()}>
      {(pos) => (
        <div
          class="notion-floating-toolbar"
          style={{
            left: `${pos().x}px`,
            top: `${pos().y}px`,
          }}
        >
          <button
            type="button"
            class="notion-toolbar-btn notion-toolbar-btn-ai"
            classList={{ "notion-toolbar-btn-active": props.aiMenuOpen() }}
            title="AI actions"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (props.aiMenuOpen()) {
                props.overlayEvent({ type: "TOGGLE_AI_MENU" })
                return
              }
              props.openAiComposer()
            }}
          >
            {props.aiBusy() ? <span class="notion-ai-dots"><span /></span> : "Ask AI"}
          </button>
          <div class="notion-toolbar-divider" />
          <For each={FLOATING_TOOLBAR_ITEMS}>
            {(item) =>
              item.key === "link" ? (
                <div class="notion-link-wrap">
                  <button
                    type="button"
                    class="notion-toolbar-btn"
                    classList={{
                      "notion-toolbar-btn-active": activeMark(item) || props.linkMenuOpen(),
                    }}
                    title="Link"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={toggleLinkMenu}
                  >
                    {item.icon}
                  </button>
                  <Show when={props.linkMenuOpen()}>
                    <div class="notion-link-popover">
                      <div class="notion-link-title">Insert link</div>
                      <input
                        ref={(el) => {
                          linkInputRef = el
                        }}
                        type="text"
                        class="notion-link-input"
                        value={props.linkValue()}
                        placeholder="Paste URL..."
                        onInput={(e) => props.setLinkValue(e.currentTarget.value)}
                        onMouseDown={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault()
                            applyLinkValue()
                            return
                          }
                          if (e.key !== "Escape") return
                          e.preventDefault()
                          props.setLinkMenuOpen(false)
                        }}
                      />
                      <div class="notion-link-actions">
                        <button
                          type="button"
                          class="notion-link-btn notion-link-btn-primary"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={applyLinkValue}
                        >
                          Apply
                        </button>
                        <button
                          type="button"
                          class="notion-link-btn"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            const t = props.editor()
                            if (!t) return
                            t.chain().focus().extendMarkRange("link").unsetLink().run()
                            props.setLinkMenuOpen(false)
                            props.bumpTick()
                            props.scheduleToolbar(80)
                          }}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  </Show>
                </div>
              ) : (
                <button
                  type="button"
                  class="notion-toolbar-btn"
                  classList={{
                    "notion-toolbar-btn-active": activeMark(item),
                  }}
                  title={item.label}
                  style={item.style}
                  onMouseDown={(e) => {
                    e.preventDefault() // Don't blur editor
                    const t = props.editor()
                    if (!t) return
                    props.setLinkMenuOpen(false)
                    props.setTableMenuOpen(false)
                    item.run(t)
                    props.bumpTick()
                    props.scheduleToolbar(80)
                  }}
                >
                  {item.icon}
                </button>
              )
            }
          </For>
          <div class="notion-toolbar-divider" />
          <div class="notion-toolbar-more-wrap">
            <button
              type="button"
              class="notion-toolbar-btn"
              classList={{ "notion-toolbar-btn-active": props.moreMenuOpen() }}
              title="More formatting"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                props.setAiError(undefined)
                props.setLinkMenuOpen(false)
                props.setTableMenuOpen(false)
                if (props.aiMenuOpen()) props.overlayEvent({ type: "TOGGLE_AI_MENU" })
                props.setMoreMenuOpen((open) => !open)
              }}
            >
              ⋯
            </button>
            <Show when={props.moreMenuOpen()}>
              <div
                class="notion-convert-menu"
                classList={{
                  "notion-convert-menu-above": getMoreMenuLayout().side === "above",
                  "notion-convert-menu-below": getMoreMenuLayout().side === "below",
                }}
                style={{ "max-height": `${getMoreMenuLayout().maxHeight}px` }}
              >
                <div class="notion-convert-menu-title">Turn into</div>
                <For each={CONVERT_MENU_ITEMS}>
                  {(item) => (
                    <button
                      type="button"
                      class="notion-convert-menu-item"
                      classList={{ "notion-convert-menu-item-active": activeConvert(item) }}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => runConvertItem(item)}
                    >
                      <span>{item.label}</span>
                      <Show when={activeConvert(item)}>
                        <span class="notion-convert-menu-check">✓</span>
                      </Show>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
          <Show when={props.tableActive()}>
            <div class="notion-toolbar-table-wrap">
              <button
                type="button"
                class="notion-toolbar-btn"
                classList={{ "notion-toolbar-btn-active": props.tableMenuOpen() }}
                title="Table tools"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  props.setAiError(undefined)
                  props.setLinkMenuOpen(false)
                  props.setMoreMenuOpen(false)
                  if (props.aiMenuOpen()) props.overlayEvent({ type: "TOGGLE_AI_MENU" })
                  props.setTableMenuOpen((open) => !open)
                }}
              >
                ▦
              </button>
              <Show when={props.tableMenuOpen()}>
                <div
                  class="notion-table-menu"
                  classList={{
                    "notion-table-menu-above": getTableMenuLayout().side === "above",
                    "notion-table-menu-below": getTableMenuLayout().side === "below",
                  }}
                  style={{ "max-height": `${getTableMenuLayout().maxHeight}px` }}
                >
                  <div class="notion-table-menu-title">Table</div>
                  <button
                    type="button"
                    class="notion-table-menu-item"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => runTableCommand("addRowBefore")}
                  >
                    Add row above
                  </button>
                  <button
                    type="button"
                    class="notion-table-menu-item"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => runTableCommand("addRowAfter")}
                  >
                    Add row below
                  </button>
                  <button
                    type="button"
                    class="notion-table-menu-item"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => runTableCommand("deleteRow")}
                  >
                    Delete row
                  </button>
                  <div class="notion-table-menu-separator" />
                  <button
                    type="button"
                    class="notion-table-menu-item"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => runTableCommand("addColumnBefore")}
                  >
                    Add column left
                  </button>
                  <button
                    type="button"
                    class="notion-table-menu-item"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => runTableCommand("addColumnAfter")}
                  >
                    Add column right
                  </button>
                  <button
                    type="button"
                    class="notion-table-menu-item"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => runTableCommand("deleteColumn")}
                  >
                    Delete column
                  </button>
                  <div class="notion-table-menu-separator" />
                  <button
                    type="button"
                    class="notion-table-menu-item notion-table-menu-item-danger"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => runTableCommand("deleteTable")}
                  >
                    Delete table
                  </button>
                </div>
              </Show>
            </div>
          </Show>
        </div>
      )}
    </Show>
  )
}
