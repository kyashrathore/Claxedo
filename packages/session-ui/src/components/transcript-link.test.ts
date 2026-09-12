import { describe, expect, test } from "bun:test"
import {
  dispatchTranscriptLinkOpen,
  transcriptLinkHref,
  transcriptLinks,
  transcriptLinkUriPattern,
} from "./transcript-link"

const REPORT_URL = "http://localhost:6006/?path=/story/playground-transcript-lab--lab"

describe("transcriptLinkHref", () => {
  test("accepts every scheme the host can open", () => {
    expect(transcriptLinkHref(REPORT_URL)).toBe(REPORT_URL)
    expect(transcriptLinkHref("https://example.com/a/b")).toBe("https://example.com/a/b")
    expect(transcriptLinkHref("file:///Users/dev/notes.md")).toBe("file:///Users/dev/notes.md")
    expect(transcriptLinkHref("mailto:dev@example.com")).toBe("mailto:dev@example.com")
    expect(transcriptLinkHref("vscode://file/Users/dev/notes.md:12")).toBe("vscode://file/Users/dev/notes.md:12")
    expect(transcriptLinkHref("claxedo://documents/open?id=doc_1")).toBe("claxedo://documents/open?id=doc_1")
  })

  test("rejects script-bearing and unopenable targets", () => {
    expect(transcriptLinkHref("javascript:alert(1)")).toBeUndefined()
    expect(transcriptLinkHref("data:text/html,<script>alert(1)</script>")).toBeUndefined()
    expect(transcriptLinkHref("ftp://example.com/pub")).toBeUndefined()
    expect(transcriptLinkHref("bun test src")).toBeUndefined()
    expect(transcriptLinkHref("curl https://example.com")).toBeUndefined()
  })

  test("drops the sentence punctuation a URL was written into", () => {
    expect(transcriptLinkHref("https://example.com/docs.")).toBe("https://example.com/docs")
    expect(transcriptLinkHref("  file:///tmp/out.log,  ")).toBe("file:///tmp/out.log")
  })
})

describe("transcriptLinks", () => {
  test("extracts each distinct link from tool output", () => {
    const output = [
      "Storybook started on " + REPORT_URL,
      "wrote file:///tmp/report.json (see file:///tmp/report.json)",
      "mail dev@example.com or mailto:dev@example.com.",
    ].join("\n")

    expect(transcriptLinks(output)).toEqual([
      REPORT_URL,
      "file:///tmp/report.json",
      "mailto:dev@example.com",
    ])
  })

  test("returns nothing for text without a link", () => {
    expect(transcriptLinks("no links here")).toEqual([])
    expect(transcriptLinks(undefined)).toEqual([])
  })
})

describe("transcriptLinkUriPattern", () => {
  test("keeps every routable scheme plus in-document and relative targets", () => {
    for (const value of [
      REPORT_URL,
      "https://example.com",
      "file:///Users/dev/notes.md",
      "mailto:dev@example.com",
      "vscode://file/Users/dev/notes.md",
      "claxedo://documents/open?id=doc_1",
      "#findings",
      "/docs/plan.md",
      "./docs/plan.md",
      "docs/plan.md",
      "notes.md",
      "ftp://example.com/pub",
      "tel:+15551234",
      "sms:+15551234",
      "xmpp:dev@example.com",
    ]) {
      expect(transcriptLinkUriPattern.test(value)).toBe(true)
    }
  })

  test("rejects script payloads", () => {
    for (const value of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "vbscript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
    ]) {
      expect(transcriptLinkUriPattern.test(value)).toBe(false)
    }
  })
})

describe("dispatchTranscriptLinkOpen", () => {
  test("carries the href on a cancelable bubbling event", () => {
    const target = new EventTarget()
    const events: CustomEvent[] = []
    target.addEventListener("claxedo:open-link", (event) => {
      events.push(event as CustomEvent)
      event.preventDefault()
    })

    expect(dispatchTranscriptLinkOpen(target, REPORT_URL)).toBe(true)
    expect(events[0]?.detail).toEqual({ href: REPORT_URL })
    expect(events[0]?.bubbles).toBe(true)
    expect(events[0]?.cancelable).toBe(true)
  })

  test("reports the link unhandled when no listener claims it", () => {
    const target = new EventTarget()
    target.addEventListener("claxedo:open-link", () => {})
    expect(dispatchTranscriptLinkOpen(target, REPORT_URL)).toBe(false)
  })
})
