import { cleanup, render } from "@solidjs/testing-library"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { sanitizeMarkdown } from "@opencode-ai/session-ui/markdown-cache"
import { Suspense } from "solid-js"
import { afterEach, describe, expect, test, vi } from "vitest"
import { createTimelineLinkOpen } from "./timeline-link-open"
import { handleExternalLinkClick } from "../../../../../claxedo-desktop/src/renderer/external-link"

const REPORT_URL = "http://localhost:6006/?path=/story/playground-transcript-lab--lab"
const FILE_URL = "file:///Users/dev/work/notes.md"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function mountMarkdown(text: string) {
  const view = render(() => (
    <Suspense fallback={<div>loading</div>}>
      <MarkedProvider>
        <Markdown text={text} cacheKey={`link-${crypto.randomUUID()}`} richAfterMs={0} />
      </MarkedProvider>
    </Suspense>
  ))
  return view.container
}

async function anchorFor(text: string) {
  const container = mountMarkdown(text)
  const deadline = performance.now() + 2_000
  while (performance.now() < deadline) {
    const anchor = container.querySelector("a[href]")
    if (anchor) return anchor as HTMLAnchorElement
    await wait(10)
  }
  return undefined
}

function linkEvent(href: string) {
  return new CustomEvent("claxedo:open-link", { bubbles: true, cancelable: true, detail: { href } })
}

afterEach(() => cleanup())

describe("desktop and transcript share one click", () => {
  test.each([
    { name: "ordinary preview click", href: REPORT_URL, modifier: {}, browser: 1, external: 0 },
    { name: "Cmd-click", href: REPORT_URL, modifier: { metaKey: true }, browser: 0, external: 1 },
    { name: "Ctrl-click", href: REPORT_URL, modifier: { ctrlKey: true }, browser: 0, external: 1 },
    { name: "external website", href: "https://example.com/", modifier: {}, browser: 0, external: 1 },
  ])("$name opens exactly one destination", async ({ href, modifier, browser, external }) => {
    const anchor = await anchorFor(`[Open prototype](${href})`)
    expect(anchor).toBeTruthy()
    expect(anchor?.classList.contains("external-link")).toBe(true)
    const openBrowser = vi.fn()
    const openExternal = vi.fn()
    const host = createTimelineLinkOpen({
      workspacePanel: { open: openBrowser },
      sdk: { directory: "/work/project" },
      paneId: "pane-1",
      platform: { openLink: openExternal },
    })
    const stop = host.listen(anchor!.parentElement!)
    const shellClick = (event: MouseEvent) => handleExternalLinkClick(event, openExternal)
    document.addEventListener("click", shellClick)
    try {
      const click = new MouseEvent("click", { bubbles: true, cancelable: true, ...modifier })
      anchor!.dispatchEvent(click)
      expect(openBrowser).toHaveBeenCalledTimes(browser)
      expect(openExternal).toHaveBeenCalledTimes(external)
      if (external) expect(openExternal).toHaveBeenCalledWith(href)
      expect(click.defaultPrevented).toBe(true)
    } finally {
      stop()
      document.removeEventListener("click", shellClick)
    }
  })
})

describe("transcript links reach the host", () => {
  test("a code span carrying the reported localhost URL renders an anchor", async () => {
    const anchor = await anchorFor("Open `" + REPORT_URL + "` to see it.")
    expect(anchor?.getAttribute("href")).toBe(REPORT_URL)
  })

  test("a code span carrying a file URL renders an anchor", async () => {
    const anchor = await anchorFor("It landed in `" + FILE_URL + "` already.")
    expect(anchor?.getAttribute("href")).toBe(FILE_URL)
  })

  test("a bare file URL in prose renders the same anchor", async () => {
    const anchor = await anchorFor("It landed in " + FILE_URL + " already.")
    expect(anchor?.getAttribute("href")).toBe(FILE_URL)
    expect(anchor?.textContent).toBe(FILE_URL)
  })

  test("a bare registered-scheme URL in prose renders an anchor", async () => {
    const anchor = await anchorFor("Reopen vscode://file/Users/dev/work/notes.md:12 to continue.")
    expect(anchor?.getAttribute("href")).toBe("vscode://file/Users/dev/work/notes.md:12")
  })

  test("a scheme outside the closed list stays text in prose", async () => {
    const container = mountMarkdown("Run javascript:alert(1) and smb://attacker/share never.")
    await wait(200)
    expect(container.querySelector("a[href]")).toBeNull()
    expect(container.textContent).toContain("javascript:alert(1)")
  })

  test("clicking an anchor asks the host first and keeps its own default when the host declines", async () => {
    const anchor = await anchorFor("Open `" + REPORT_URL + "` to see it.")
    expect(anchor).toBeTruthy()
    const seen: string[] = []
    document.addEventListener("claxedo:open-link", (event) => {
      seen.push(String((event as CustomEvent).detail.href))
    })

    const declined = new MouseEvent("click", { bubbles: true, cancelable: true })
    anchor?.dispatchEvent(declined)
    expect(seen).toEqual([REPORT_URL])
    expect(declined.defaultPrevented).toBe(false)

    document.addEventListener("claxedo:open-link", (event) => event.preventDefault(), { once: true })
    const claimed = new MouseEvent("click", { bubbles: true, cancelable: true })
    anchor?.dispatchEvent(claimed)
    expect(claimed.defaultPrevented).toBe(true)
  })
})

describe("sanitized markdown keeps the hrefs a host can route", () => {
  const href = (html: string) => {
    const host = document.createElement("div")
    host.innerHTML = sanitizeMarkdown(html)
    return host.querySelector("a")?.getAttribute("href") ?? undefined
  }

  test("an explicit link to a file survives sanitization", () => {
    expect(href(`<p><a href="${FILE_URL}">notes</a></p>`)).toBe(FILE_URL)
    expect(href('<p><a href="vscode://file/Users/dev/notes.md:12">open</a></p>')).toBe(
      "vscode://file/Users/dev/notes.md:12",
    )
    expect(href(`<p><a href="${REPORT_URL}">lab</a></p>`)).toBe(REPORT_URL)
    expect(href('<p><a href="mailto:dev@example.com">mail</a></p>')).toBe("mailto:dev@example.com")
  })

  test("in-document and relative targets are untouched", () => {
    expect(href('<p><a href="#findings">jump</a></p>')).toBe("#findings")
    expect(href('<p><a href="./docs/plan.md">plan</a></p>')).toBe("./docs/plan.md")
    expect(href('<p><a href="docs/plan.md">plan</a></p>')).toBe("docs/plan.md")
  })

  test("a script-bearing target still loses its href", () => {
    expect(href('<p><a href="javascript:alert(1)">x</a></p>')).toBeUndefined()
    expect(href('<p><a href="java&#9;script:alert(1)">x</a></p>')).toBeUndefined()
    expect(href('<p><a href="data:text/html,<script>alert(1)</script>">x</a></p>')).toBeUndefined()
  })

  test("an inline image still renders from a data URI", () => {
    const pixel =
      "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
    const host = document.createElement("div")
    host.innerHTML = sanitizeMarkdown(`<p><img src="${pixel}" alt="pixel"></p>`)
    expect(host.querySelector("img")?.getAttribute("src")).toBe(pixel)
  })
})

describe("createTimelineLinkOpen", () => {
  const host = () => ({
    workspacePanel: { open: vi.fn() },
    sdk: { directory: "/repo/main/" },
    paneId: "pane-1",
    platform: { openLink: vi.fn(), openPath: vi.fn() },
  })

  const openedTab = (stub: ReturnType<typeof host>) => stub.workspacePanel.open.mock.calls.at(0)?.at(0)

  const deliver = (stub: Parameters<typeof createTimelineLinkOpen>[0], event: Event) => {
    const el = document.createElement("div")
    const stop = createTimelineLinkOpen(stub).listen(el)
    el.dispatchEvent(event)
    stop()
  }

  test("opens a loopback URL as a workspace Browser tab in this pane", () => {
    const stub = host()
    const event = linkEvent(REPORT_URL)
    deliver(stub, event)

    expect(openedTab(stub)).toEqual({
      workspaceDir: "/repo/main",
      targetPaneId: "pane-1",
      navigator: null,
      focus: { kind: "browser", url: REPORT_URL },
    })
    expect(stub.platform.openLink).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  test("hands every other loopback spelling the same tab", () => {
    for (const url of ["http://127.0.0.1:3000/", "https://0.0.0.0:8080/app", "http://[::1]:6006/"]) {
      const stub = host()
      deliver(stub, linkEvent(url))
      expect(openedTab(stub)).toMatchObject({ focus: { kind: "browser", url } })
    }
  })

  test("hands a public URL and a mail address to the OS", () => {
    const stub = host()
    const web = linkEvent("https://example.com/docs")
    deliver(stub, web)
    deliver(stub, linkEvent("mailto:dev@example.com"))

    expect(stub.platform.openLink.mock.calls).toEqual([["https://example.com/docs"], ["mailto:dev@example.com"]])
    expect(stub.workspacePanel.open).not.toHaveBeenCalled()
    expect(web.defaultPrevented).toBe(true)
  })

  test("hands a registered scheme to the OS rather than a tab", () => {
    const stub = host()
    deliver(stub, linkEvent("vscode://file/Users/dev/notes.md:12"))
    deliver(stub, linkEvent("claxedo://documents/open?id=doc_1"))

    expect(stub.platform.openLink.mock.calls).toEqual([
      ["vscode://file/Users/dev/notes.md:12"],
      ["claxedo://documents/open?id=doc_1"],
    ])
  })

  test("opens a file URL through the OS file path, decoded", () => {
    const stub = host()
    const event = linkEvent("file:///Users/dev/my%20work/notes.md")
    deliver(stub, event)

    expect(stub.platform.openPath).toHaveBeenCalledWith("/Users/dev/my work/notes.md")
    expect(event.defaultPrevented).toBe(true)
  })

  test("leaves a file URL to the anchor where the host cannot open files", () => {
    const stub = { ...host(), platform: { openLink: vi.fn() } }
    const event = linkEvent(FILE_URL)
    deliver(stub, event)

    expect(stub.workspacePanel.open).not.toHaveBeenCalled()
    expect(stub.platform.openLink).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  test("ignores an event without an openable href", () => {
    const stub = host()
    const event = linkEvent("javascript:alert(1)")
    deliver(stub, event)
    deliver(stub, new CustomEvent("claxedo:open-link", { cancelable: true, detail: {} }))

    expect(stub.workspacePanel.open).not.toHaveBeenCalled()
    expect(stub.platform.openLink).not.toHaveBeenCalled()
    expect(stub.platform.openPath).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })
})
