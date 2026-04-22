/**
 * Wraps `LineCommentEditor` (the same inline editor used in review
 * workspaces) for authoring a comment on a selected DOM element. Renders a
 * selector chip + optional screenshot thumbnail in the selection slot.
 *
 * The composer is deliberately presentation-only — it calls
 * `onElementComment` with the full payload and leaves pane-bus / session
 * wiring to the caller (browser pane).
 */

import { LineCommentEditor } from "@opencode-ai/ui/line-comment"
import { Show, createSignal, type Component } from "solid-js"
import type { BrowserNodeSelectedPayload } from "../store/browser-pane-context"
import type { PageElementCommentBoundingBox, PageElementCommentPayload } from "../store/browser-comments"
import { ElementSelectionChip } from "./element-selection-chip"

export type ElementCommentComposerProps = {
  tabId: string
  pageUrl: string
  node: BrowserNodeSelectedPayload & { ok: true }
  onElementComment: (payload: PageElementCommentPayload) => void
  onCancel: () => void
  /**
   * When supplied, used to format the free-form `comment` into the synthetic
   * note text that rides on the payload. Defaults to
   * `formatElementCommentNote`.
   */
  formatNote: (args: {
    selector: string
    pageUrl: string
    comment: string
    outerHTML?: string
  }) => string
  autofocus?: boolean
  placeholder?: string
}

export const ElementCommentComposer: Component<ElementCommentComposerProps> = (props) => {
  const [value, setValue] = createSignal("")

  const selector = () => {
    const n = props.node
    return n.shadow ? `${n.shadow.host} >> ${n.shadow.inner}` : n.selector
  }

  const boundingBox = (): PageElementCommentBoundingBox | undefined => {
    const bb = props.node.boundingBox
    if (!bb) return undefined
    return {
      x: bb.x,
      y: bb.y,
      width: bb.width,
      height: bb.height,
    }
  }

  const submit = (finalValue: string) => {
    const trimmed = finalValue.trim()
    if (!trimmed) return
    const sel = selector()
    const pageUrl = props.pageUrl || props.node.frameUrl
    const payload: PageElementCommentPayload = {
      tabId: props.tabId,
      pageUrl,
      selector: sel,
      comment: trimmed,
      noteText: props.formatNote({
        selector: sel,
        pageUrl,
        comment: trimmed,
        outerHTML: props.node.outerHTML,
      }),
      boundingBox: boundingBox(),
      outerHTML: props.node.outerHTML,
      screenshotDataUrl: props.node.screenshotDataUrl,
    }
    setValue("")
    props.onElementComment(payload)
  }

  return (
    <div data-testid="element-comment-composer" class="border-b border-border bg-background p-2">
      <Show when={props.node.screenshotDataUrl}>
        <div class="mb-2 overflow-hidden rounded border border-border">
          <img
            src={props.node.screenshotDataUrl}
            alt={`Selected element preview (${selector()})`}
            data-testid="element-comment-composer-thumbnail"
            class="max-h-32 w-full object-contain"
          />
        </div>
      </Show>
      <LineCommentEditor
        inline
        top={0}
        autofocus={props.autofocus ?? true}
        value={value()}
        onInput={setValue}
        onCancel={props.onCancel}
        onSubmit={submit}
        placeholder={props.placeholder ?? "Comment on this element…"}
        selection={<ElementSelectionChip selector={selector()} />}
      />
    </div>
  )
}
