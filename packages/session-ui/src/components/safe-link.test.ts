import { describe, expect, test } from "bun:test"
import { parseSafeLink, safeLinkHref } from "./safe-link"

describe("parseSafeLink", () => {
  test("types host routes and in-document references as internal", () => {
    for (const value of [
      "/s/ses_1",
      "/tasks/tsk_9?panel=changes",
      "#findings",
      "?panel=changes",
      "./docs/plan.md",
      "../docs/plan.md",
    ]) {
      expect(parseSafeLink(value)).toEqual({ kind: "internal", href: value })
    }
  })

  test("types every host-openable absolute scheme as external", () => {
    for (const value of [
      "https://example.com/a/b",
      "http://localhost:3000/preview",
      "file:///Users/dev/notes.md",
      "vscode://file/Users/dev/notes.md:12",
      "claxedo://documents/open?id=doc_1",
      "mailto:dev@example.com",
    ]) {
      expect(parseSafeLink(value)).toEqual({ kind: "external", href: value })
    }
  })

  test("rejects script-bearing and unopenable schemes however spelled", () => {
    for (const value of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "java\tscript:alert(1)",
      "  javascript:alert(1)  ",
      "javascript://host/path",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "tel:+15551234",
      "ftp://example.com/pub",
      "ssh://host/path",
      "java%0Ascript:alert(1)",
    ]) {
      expect(parseSafeLink(value)).toBeUndefined()
    }
  })

  test("rejects targets that rebase onto another host", () => {
    for (const value of ["//evil.example/path", "\\\\evil.example", "/\\evil.example", "\\/evil.example"]) {
      expect(parseSafeLink(value)).toBeUndefined()
    }
  })

  test("rejects bare relative paths, prose, and empty values", () => {
    for (const value of [undefined, null, "", "   ", "docs/plan.md", "not a link at all"]) {
      expect(parseSafeLink(value)).toBeUndefined()
    }
  })
})

describe("safeLinkHref", () => {
  test("hands back the caller's string for a link that parses", () => {
    expect(safeLinkHref("/s/ses_1")).toBe("/s/ses_1")
    expect(safeLinkHref("https://example.com/a")).toBe("https://example.com/a")
    expect(safeLinkHref("  https://example.com/a  ")).toBe("https://example.com/a")
  })

  test("withholds the href for a scheme the host cannot open", () => {
    expect(safeLinkHref("javascript:alert(1)")).toBeUndefined()
    expect(safeLinkHref("data:text/html,x")).toBeUndefined()
  })
})
