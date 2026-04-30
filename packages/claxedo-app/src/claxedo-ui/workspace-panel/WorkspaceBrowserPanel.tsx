/**
 * WorkspaceBrowserPanel
 *
 * Workspace-panel host for the agentic browser tab. Mounts the BrowserPane
 * component (live <webview> + react-grab in-page comment popover) and routes
 * comment payloads up to the focused session's prompt.context.
 *
 * Replaces the deleted multi-pane integration: in the old layout, a "browser"
 * tab type lived alongside session/terminal/file tabs and used pane-bus to
 * route comments to a sibling session pane. In the workspace-panel model the
 * browser is a singleton panel rendered next to whatever surface is focused;
 * routing is implicit (panel → focused session) with no binding step.
 *
 * The panel is mode="browser" inside WorkspacePanelMode. The button that
 * toggles it lives in rail-layout's top bar.
 */

import { useBrowserHistory } from "../../browser/store/browser-history"
import { useBrowserComments } from "../../browser/store/browser-comments"
import { BrowserPane, type BrowserPaneCommentPayload } from "../../browser/components/browser-pane"
import { usePrompt } from "@/context/prompt"
import { Show } from "solid-js"

export type WorkspaceBrowserPanelProps = {
  /**
   * Stable identifier for the panel mount. Used as the BrowserPane's
   * `paneId` (the desktop main process keys CDP attaches by it) and as the
   * tabId for the local browser-comments store. The workspace panel is a
   * singleton per directory, so a stable string per directory is fine.
   */
  panelKey: string
  /**
   * Active session id resolved by the parent WorkspacePanelBody. May be
   * "new" if no session is focused — comments still land in
   * prompt.context, but the user must commit them to a session via the
   * usual "send" affordance.
   */
  sessionId: string
}

export function WorkspaceBrowserPanel(props: WorkspaceBrowserPanelProps) {
  // The PromptProvider is in scope here (DirectoryScope mounts it). For
  // tests / cloud builds where it's missing, the optional try/catch
  // mirrors the pattern in browser-pane.tsx for useBrowserHistory.
  let prompt: ReturnType<typeof usePrompt> | undefined
  try {
    prompt = usePrompt()
  } catch {
    prompt = undefined
  }

  let comments: ReturnType<typeof useBrowserComments> | undefined
  try {
    comments = useBrowserComments()
  } catch {
    comments = undefined
  }

  let history: ReturnType<typeof useBrowserHistory> | undefined
  try {
    history = useBrowserHistory()
  } catch {
    history = undefined
  }

  const handlePageComment = (payload: BrowserPaneCommentPayload): boolean => {
    // Local-history record under the producing tab so the comment shows
    // up in any future "recent comments" UI even if no session was
    // focused at the moment of submit.
    comments?.add({
      tabId: payload.tabId,
      pageUrl: payload.pageUrl,
      selector: payload.selector,
      comment: payload.comment,
      noteText: payload.noteText,
      outerHTML: payload.outerHTML,
      boundingBox: payload.boundingBox,
    })
    if (!prompt || props.sessionId === "new" || !props.sessionId) return false
    // Use the FileContextItem shape with a URL-shaped path. The
    // submit.ts override on dev splits these out of the file-fetch path
    // and emits text-only request parts so the agent doesn't try to
    // file:// the URL.
    prompt.context.add({
      type: "file",
      path: payload.pageUrl || "page",
      comment: payload.noteText?.trim() || payload.comment?.trim() || "",
      commentOrigin: "file",
      preview: payload.selector || undefined,
    })
    return true
  }

  return (
    <div
      class="flex h-full min-h-0 w-full flex-col overflow-hidden bg-background-base"
      data-component="workspace-browser-panel"
      data-testid="workspace-browser-panel"
    >
      <Show when={history} keyed fallback={<BrowserPaneMount {...props} onPageComment={handlePageComment} />}>
        <BrowserPaneMount {...props} onPageComment={handlePageComment} />
      </Show>
    </div>
  )
}

function BrowserPaneMount(props: WorkspaceBrowserPanelProps & {
  onPageComment: (p: BrowserPaneCommentPayload) => boolean
}) {
  return (
    <BrowserPane
      paneId={props.panelKey}
      tabId={props.panelKey}
      browserId={props.panelKey}
      onPageComment={props.onPageComment}
    />
  )
}
