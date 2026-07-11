import { describe, expect, test } from "bun:test"
import { buildScreenshotAttachment } from "./workspace-browser-panel"
import type { BrowserPaneCommentPayload } from "../../browser/components/browser-pane"

// buildScreenshotAttachment turns a browser comment payload's viewport
// screenshot data-URL into a prompt ImageAttachmentPart: it validates the
// data-URL, sniffs the mime type, and builds a sanitized filename.

const payload = (input: Partial<BrowserPaneCommentPayload>): BrowserPaneCommentPayload =>
  ({
    tabId: "tab",
    pageUrl: "https://example.test",
    selector: "button",
    comment: "",
    noteText: "",
    ...input,
  }) as BrowserPaneCommentPayload

describe("buildScreenshotAttachment", () => {
  test("returns undefined when no screenshot data-URL is present", () => {
    expect(buildScreenshotAttachment(payload({}))).toBeUndefined()
  })

  test("returns undefined when the data-URL is not an image", () => {
    expect(buildScreenshotAttachment(payload({ screenshotDataUrl: "data:text/plain;base64,AAAA" }))).toBeUndefined()
  })

  test("sniffs the mime type and extension from the data-URL", () => {
    const result = buildScreenshotAttachment(payload({ screenshotDataUrl: "data:image/jpeg;base64,ZZZ" }))
    expect(result?.type).toBe("image")
    expect(result?.mime).toBe("image/jpeg")
    expect(result?.dataUrl).toBe("data:image/jpeg;base64,ZZZ")
    expect(result?.filename).toMatch(/^browser-button-\d+\.jpeg$/)
  })

  test("falls back to image/png when the data-URL has no mime terminator", () => {
    const result = buildScreenshotAttachment(payload({ screenshotDataUrl: "data:image/anything" }))
    expect(result?.mime).toBe("image/png")
    expect(result?.filename).toMatch(/\.png$/)
  })

  test("sanitizes the selector into the filename (punctuation to dashes, trimmed, capped)", () => {
    const result = buildScreenshotAttachment(
      payload({ selector: 'div.foo > .bar"quote"', screenshotDataUrl: "data:image/png;base64,AAAA" }),
    )
    expect(result?.filename).toMatch(/^browser-div-foo-bar-quote-\d+\.png$/)
    expect(result?.filename).not.toContain('"')
    expect(result?.filename).not.toContain(">")
  })

  test("uses the 'element' fallback token when the selector is empty", () => {
    const result = buildScreenshotAttachment(
      payload({ selector: "", screenshotDataUrl: "data:image/png;base64,AAAA" }),
    )
    expect(result?.filename).toMatch(/^browser-element-\d+\.png$/)
  })
})
