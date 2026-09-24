import { asRecord, readString } from "@/lib/record"
import type { TimelineFocus, TimelinePlatform } from "./model"

/**
 * A dev server the agent just started is work in progress, not somewhere else:
 * the "Local preview" chip already treats a loopback URL as a surface of this
 * workspace, and every one of these spellings reaches the same server.
 */
const loopbackHosts: readonly string[] = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]

export type TimelineLinkHost = {
  openFocus: (focus: TimelineFocus) => void
  platform: Pick<TimelinePlatform, "openLink" | "openPath">
}

function osPath(url: URL) {
  const decoded = decodeURIComponent(url.pathname)
  // A Windows file URL carries the drive letter inside the path (`/C:/…`).
  return /^\/[a-z]:[\\/]/i.test(decoded) ? decoded.slice(1) : decoded
}

/**
 * Where a link in the transcript opens. Leaving the event uncancelled hands the
 * link back to the anchor's own `target="_blank"`, so a target this host has no
 * route for behaves as it did before.
 */
export function createTimelineLinkOpen(host: TimelineLinkHost) {
  const openBrowserTab = (url: string) => {
    host.openFocus({ kind: "browser", url })
  }

  const onOpenLink = (event: Event) => {
    const href = readString(event instanceof CustomEvent ? asRecord(event.detail) : undefined, "href")
    if (!href) return
    let url: URL
    try {
      url = new URL(href)
    } catch {
      return
    }

    if (url.protocol === "http:" || url.protocol === "https:") {
      event.preventDefault()
      if (loopbackHosts.includes(url.hostname)) openBrowserTab(url.href)
      else host.platform.openLink(url.href)
      return
    }

    if (url.protocol === "file:") {
      if (!host.platform.openPath) return
      event.preventDefault()
      void host.platform.openPath(osPath(url))
      return
    }

    if (url.protocol === "mailto:" || url.protocol === "vscode:" || url.protocol === "claxedo:") {
      event.preventDefault()
      host.platform.openLink(url.href)
    }
  }

  return {
    openBrowserTab,
    listen(el: HTMLElement) {
      el.addEventListener("claxedo:open-link", onOpenLink)
      return () => el.removeEventListener("claxedo:open-link", onOpenLink)
    },
  }
}
