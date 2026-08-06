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
 * The browser now lives as a tab inside ReviewWorkspace.
 */

import { useBrowserHistory } from "@/features/browser"
import { useBrowserComments } from "@/features/browser"
import { BrowserPane, type BrowserPaneCommentPayload } from "@/features/browser"
import { usePrompt, type ImageAttachmentPart } from "@/features/session/providers/prompt"

export function buildScreenshotAttachment(payload: BrowserPaneCommentPayload): ImageAttachmentPart | undefined {
  const dataUrl = payload.screenshotDataUrl
  if (!dataUrl || !dataUrl.startsWith("data:image/")) return undefined
  // Mime is between "data:" and the first ";" — fall back to image/png if missing.
  const mimeEnd = dataUrl.indexOf(";", 5)
  const mime = mimeEnd > 5 ? dataUrl.slice(5, mimeEnd) : "image/png"
  // Sanitize selector for filename: drop quotes/punct, cap at 32 chars.
  const safeSelector = (payload.selector || "element").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "element"
  const filename = `browser-${safeSelector}-${Date.now()}.${mime.split("/")[1] || "png"}`
  return {
    type: "image",
    id: `browser-pick-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    filename,
    mime,
    dataUrl,
  }
}

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
  initialUrl?: string
  navigationVersion?: number
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
    // Append the viewport screenshot (if captured) as an image attachment
    // on the prompt. The prompt-input UI's `imageAttachments` memo filters
    // ImageAttachmentParts out of `prompt.current()`, so the agent picks
    // it up on submit alongside the comment text.
    const attachment = buildScreenshotAttachment(payload)
    if (attachment) {
      prompt.set([...prompt.current(), attachment])
    }
    return true
  }

  return (
    <div
      class="flex h-full min-h-0 w-full flex-col overflow-hidden bg-background-base"
      data-component="workspace-browser-panel"
      data-testid="workspace-browser-panel"
    >
      <BrowserPaneMount {...props} onPageComment={handlePageComment} />
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
      initialUrl={props.initialUrl}
      hostedUrl={props.initialUrl}
      navigationVersion={props.navigationVersion}
      onPageComment={props.onPageComment}
    />
  )
}
