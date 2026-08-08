import { setMarkdownTableViewer } from "@/ui/session-kit"
import { openTableViewer } from "./markdown-viewer"

let installed = false

/** Registers Claxedo's full-screen table viewer at the shared Markdown boundary. */
export function installTimelineTables() {
  if (installed) return
  installed = true
  setMarkdownTableViewer(openTableViewer)
}
