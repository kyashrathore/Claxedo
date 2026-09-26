import { setMarkdownTableViewer } from "@/transcript"
import { openTableViewer } from "./markdown-viewer"

let installed = false

export function installTimelineTables() {
  if (installed) return
  installed = true
  setMarkdownTableViewer(openTableViewer)
}
