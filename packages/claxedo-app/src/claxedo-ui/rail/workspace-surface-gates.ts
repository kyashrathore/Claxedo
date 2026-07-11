import { isGlobalContent, realDirectory, type ContentMeta } from "../state/types"
import type { WorkspacePanelPaneTarget } from "../workspace-panel/workspace-panel-state"
import { hasBacking } from "../../shell/identity/session-ref"

export function workspaceToolsBlockedForContent(content: ContentMeta | undefined) {
  const ref = content?.content?.sessionRef
  return !!ref && !hasBacking(ref)
}

export function workspaceToolDirectoryForContent(content: ContentMeta | undefined) {
  if (!content || workspaceToolsBlockedForContent(content) || isGlobalContent(content)) return undefined
  const ref = content.content?.sessionRef
  if (ref?.toolSandbox?.kind === "local") return ref.toolSandbox.cwd
  return realDirectory(content.directory)
}

export function workspacePanelTargetForContent(
  content: ContentMeta | undefined,
  paneId: string,
): WorkspacePanelPaneTarget | undefined {
  const workspaceDir = workspaceToolDirectoryForContent(content)
  if (!workspaceDir) return undefined
  return { workspaceDir, targetPaneId: paneId }
}
