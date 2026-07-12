/**
 * AI overlay UI for the page editor: the "Ask AI" composer menu and the
 * AI result preview panel.
 *
 * Pure presentation over signals/handlers owned by PageEditorLoaded —
 * received as props. The composer textarea element is reported back via
 * `setCustomAiInput` because the AI action factory (page-editor-ai.ts)
 * reads it for focus/resize. Extracted verbatim from page-editor.tsx
 * (Plan 005); markup, classes, and behavior unchanged.
 */

import { Show, For } from "solid-js"
import {
  normalizeInstruction,
  canRunAiMenuItem,
  AI_MENU_ITEMS,
  type OverlayState,
  type AiPanelPos,
  type AiMenuItem,
} from "./page-editor-utils"

export type PageEditorOverlayProps = {
  /** Position of the AI composer menu when open, else null. */
  openAiMenuPos: () => AiPanelPos | null
  aiBusy: () => boolean
  customAiValue: () => string
  setCustomAiValue: (v: string) => void
  setCustomAiInput: (el: HTMLTextAreaElement) => void
  resizeAiPrompt: () => void
  runCustomAiPrompt: () => void
  closeAiOverlay: (discard?: boolean) => void
  hasActiveSelection: () => boolean
  hasAiSelection: () => boolean
  runAiItem: (item: AiMenuItem) => void
  aiPreview: () => Extract<OverlayState, { type: "ai_preview" }> | null
  applyAiDraft: (mode: "accept" | "discard" | "insert-below" | "insert-cursor") => void
  clearAiDraft: () => void
  rerunAiDraft: () => void
}

export function PageEditorOverlay(props: PageEditorOverlayProps) {
  return (
    <>
      <Show when={props.openAiMenuPos()}>
        {(pos) => (
          <div
            class="notion-ai-menu"
            style={{
              left: `${pos().x}px`,
              top: `${pos().y}px`,
              width: `${pos().width}px`,
            }}
          >
            <div class="notion-ai-composer">
              <textarea
                ref={(el) => {
                  props.setCustomAiInput(el)
                }}
                class="notion-ai-prompt-input"
                placeholder="Ask AI anything..."
                value={props.customAiValue()}
                rows={1}
                onFocus={() => props.resizeAiPrompt()}
                onInput={(e) => {
                  props.setCustomAiValue(e.currentTarget.value)
                  props.resizeAiPrompt()
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault()
                    props.runCustomAiPrompt()
                    return
                  }
                  if (e.key !== "Escape") return
                  e.preventDefault()
                  props.closeAiOverlay(true)
                }}
              />
              <div class="notion-ai-prompt-meta">
                <button type="button" class="notion-ai-meta-chip" onMouseDown={(e) => e.preventDefault()}>
                  Current page
                </button>
                <button
                  type="button"
                  class="notion-ai-meta-icon"
                  onMouseDown={(e) => e.preventDefault()}
                  title="Mention"
                >
                  @
                </button>
                <button
                  type="button"
                  class="notion-ai-prompt-send"
                  classList={{ "notion-ai-prompt-send-busy": props.aiBusy() }}
                  disabled={props.aiBusy() || !normalizeInstruction(props.customAiValue())}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={props.runCustomAiPrompt}
                >
                  <span class="notion-ai-send-icon">{props.aiBusy() ? <span class="notion-ai-dots"><span /></span> : "↑"}</span>
                </button>
              </div>
            </div>
            <Show when={props.hasAiSelection()}>
              <div class="notion-ai-menu-list">
                <For each={AI_MENU_ITEMS}>
                  {(item) => (
                    <button
                      type="button"
                      class="notion-ai-menu-item"
                      disabled={props.aiBusy() || !canRunAiMenuItem(item, props.hasActiveSelection(), props.hasAiSelection())}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => props.runAiItem(item)}
                    >
                      {item.label}
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        )}
      </Show>

      <Show when={props.aiPreview()}>
        {(preview) => (
          <div
            class="notion-ai-preview"
            style={{
              left: `${preview().pos.x}px`,
              top: `${preview().pos.y}px`,
              width: `${preview().pos.width}px`,
            }}
          >
            <div class="notion-ai-preview-title">{preview().draft.inline ? "AI edit preview" : "AI suggestion"}</div>
            <Show when={!preview().draft.inline}>
              <div class="notion-ai-preview-content">{preview().draft.text}</div>
            </Show>
            <div class="notion-ai-preview-actions">
              <Show when={preview().draft.inline}>
                <button
                  type="button"
                  class="notion-ai-preview-btn notion-ai-preview-btn-primary"
                  disabled={props.aiBusy()}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => props.applyAiDraft("accept")}
                >
                  Accept
                </button>
                <button
                  type="button"
                  class="notion-ai-preview-btn"
                  disabled={props.aiBusy()}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => props.applyAiDraft("insert-below")}
                >
                  Insert below
                </button>
                <button
                  type="button"
                  class="notion-ai-preview-btn"
                  disabled={props.aiBusy()}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={props.clearAiDraft}
                >
                  Discard
                </button>
              </Show>
              <Show when={!preview().draft.inline}>
                <button
                  type="button"
                  class="notion-ai-preview-btn notion-ai-preview-btn-primary"
                  disabled={props.aiBusy()}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => props.applyAiDraft("insert-cursor")}
                >
                  Insert
                </button>
              </Show>
              <button
                type="button"
                class="notion-ai-preview-btn"
                disabled={props.aiBusy()}
                onMouseDown={(e) => e.preventDefault()}
                onClick={props.rerunAiDraft}
              >
                Try again
              </button>
            </div>
          </div>
        )}
      </Show>
    </>
  )
}
