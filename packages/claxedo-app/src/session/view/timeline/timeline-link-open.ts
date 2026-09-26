import { asRecord } from "@claxedo/helpers/guards"
import { readString } from "@/lib/record"
import type { TimelineFocus, TimelinePlatform } from "./model"

const loopbackHosts: readonly string[] = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]

export type TimelineLinkHost = {
  openFocus: (focus: TimelineFocus) => void
  platform: Pick<TimelinePlatform, "openLink">
}

export function createTimelineLinkOpen(host: TimelineLinkHost) {
  const openBrowserTab = (url: string) => {
    host.openFocus({ kind: "browser", url })
  }

  const onOpenLink = (event: Event) => {
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

  return {
    openBrowserTab,
    listen(el: HTMLElement) {
      el.addEventListener("claxedo:open-link", onOpenLink)
      return () => el.removeEventListener("claxedo:open-link", onOpenLink)
    },
  }
}
