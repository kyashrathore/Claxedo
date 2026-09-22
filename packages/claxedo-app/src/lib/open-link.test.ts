import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { openableLinkHref, openLink } from "./open-link"

const initialUrl = window.location.href
afterEach(() => {
  window.location.href = initialUrl
})

function observe() {
  const open = spyOn(window, "open").mockImplementation(() => null)
  return { open, dispose: () => open.mockRestore() }
}

describe("openableLinkHref", () => {
  test.each([
    "https://github.com/kyashrathore/Claxedo",
    "http://localhost:3000/preview",
    "mailto:dev@example.com",
    "vscode://file/Users/dev/repo/README.md",
    "claxedo://open-project",
    "HTTPS://EXAMPLE.COM/UPPER",
  ])("accepts the intended scheme in %s", (url) => {
    expect(openableLinkHref(url)).toBe(new URL(url).href)
  })

  test.each([
    "javascript:alert(1)",
    "  javascript:alert(document.cookie)",
    "java\tscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "vbscript:msgbox(1)",
    "blob:https://example.com/00000000-0000-0000-0000-000000000000",
  ])("refuses %s", (url) => {
    expect(openableLinkHref(url)).toBeNull()
  })

  test("resolves an in-app path against the document origin", () => {
    window.location.href = "http://localhost:3000/w/repo"
    expect(openableLinkHref("/s/session")).toBe("http://localhost:3000/s/session")
    // A bare string is a relative reference, exactly as `window.open` treated
    // it: it lands same-origin rather than being refused.
    expect(openableLinkHref("not a url at all %")).toBe("http://localhost:3000/w/not%20a%20url%20at%20all%20%")
  })
})

describe("openLink", () => {
  test("opens an OAuth authorization URL detached from this document", () => {
    const { open, dispose } = observe()
    try {
      const url = "https://github.com/login/oauth/authorize?client_id=abc&state=xyz"
      expect(openLink(url)).toBe(true)
      expect(open.mock.calls).toEqual([[url, "_blank", "noopener,noreferrer"]])
    } finally {
      dispose()
    }
  })

  test("opens mailto and editor-protocol links through the same gate", () => {
    const { open, dispose } = observe()
    try {
      expect(openLink("mailto:dev@example.com")).toBe(true)
      expect(openLink("vscode://file/Users/dev/repo")).toBe(true)
      expect(open.mock.calls).toEqual([
        ["mailto:dev@example.com", "_blank", "noopener,noreferrer"],
        ["vscode://file/Users/dev/repo", "_blank", "noopener,noreferrer"],
      ])
    } finally {
      dispose()
    }
  })

  test.each(["javascript:alert(1)", "data:text/html,<b>x</b>", "file:///etc/passwd"])(
    "drops %s without a new context",
    (url) => {
      const { open, dispose } = observe()
      try {
        expect(openLink(url)).toBe(false)
        expect(open.mock.calls).toEqual([])
      } finally {
        dispose()
      }
    },
  )
})
