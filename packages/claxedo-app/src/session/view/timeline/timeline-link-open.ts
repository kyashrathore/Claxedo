import { asRecord } from "@claxedo/helpers/guards"
import { readString } from "@claxedo/helpers/readers"
import type { TimelineFocus, TimelinePlatform } from "./model"
import { resolveTimelinePath, timelineAbsoluteFilePath, timelineAnchorClickTarget, timelineExternalSourceClickTarget, timelineFileFocus } from "./timeline-file-paths"

const loopbackHosts: readonly string[] = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]

export type TimelineLinkHost = {
  openFocus: (focus: TimelineFocus) => void
  platform: Pick<TimelinePlatform, "openLink" | "openPath">
  placementPath: string
  onError: (error: unknown) => void
}

function fileOpeners(host: TimelineLinkHost) {
  const openFileExternally = (raw: string) => {
    const path = timelineAbsoluteFilePath(resolveTimelinePath(raw, host.placementPath))
    if (!path || !host.platform.openPath) {
      host.onError(new Error("This file cannot be opened on this computer."))
      return
    }
    void host.platform.openPath(path).catch(host.onError)
  }

  const openFile = (raw: string) => {
    const target = timelineFileFocus(raw, host.placementPath)
    if (target) host.openFocus({ kind: "file", ...target })
    else openFileExternally(raw)
  }

  return { openFile, openFileExternally }
}

function captureFileLinks(openBrowserTab: (url: string) => void, openFile: (raw: string) => void) {
  return (event: MouseEvent) => {
    const externalSourceUrl = timelineExternalSourceClickTarget(event)
    const raw = timelineAnchorClickTarget(event)
    if (!externalSourceUrl && !raw) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (externalSourceUrl) openBrowserTab(externalSourceUrl)
    else if (raw) openFile(raw)
  }
}

function externalLinkHandler(host: TimelineLinkHost, openBrowserTab: (url: string) => void) {
  return (event: Event) => {
    const href = readString(event instanceof CustomEvent ? asRecord(event.detail) : undefined, "href")
    if (!href) return
    if (!URL.canParse(href)) return
    const url = new URL(href)

    if (url.protocol === "http:" || url.protocol === "https:") {
      event.preventDefault()
      if (loopbackHosts.includes(url.hostname)) openBrowserTab(url.href)
      else host.platform.openLink(url.href)
      return
    }

    if (url.protocol === "mailto:" || url.protocol === "vscode:" || url.protocol === "claxedo:") {
      event.preventDefault()
      host.platform.openLink(url.href)
    }
  }
}

export function createTimelineLinkOpen(host: TimelineLinkHost) {
  const openBrowserTab = (url: string) => host.openFocus({ kind: "browser", url })
  const { openFile, openFileExternally } = fileOpeners(host)
  const onCapture = captureFileLinks(openBrowserTab, openFile)
  const onOpenLink = externalLinkHandler(host, openBrowserTab)
  return {
    openBrowserTab,
    openFile,
    openFileExternally,
    listen(el: HTMLElement) {
      el.addEventListener("claxedo:open-link", onOpenLink)
      el.addEventListener("click", onCapture, { capture: true })
      return () => {
        el.removeEventListener("claxedo:open-link", onOpenLink)
        el.removeEventListener("click", onCapture, { capture: true })
      }
    },
  }
}
