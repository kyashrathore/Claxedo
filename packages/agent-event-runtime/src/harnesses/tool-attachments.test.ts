import { describe, expect, test } from "bun:test"
import { attachmentBytes, imageAttachment, TOOL_ATTACHMENT_INLINE_MAX_BYTES } from "./tool-attachments"

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

describe("attachment size", () => {
  test("reports the bytes an image decodes to, not the length of its base64", () => {
    const encoded = "A".repeat(400)
    expect(attachmentBytes(encoded)).toBe(300)
    expect(attachmentBytes(`data:image/png;base64,${encoded}`)).toBe(300)
  })

  test("discounts base64 padding", () => {
    expect(attachmentBytes("AAAA")).toBe(3)
    expect(attachmentBytes("AAA=")).toBe(2)
    expect(attachmentBytes("AA==")).toBe(1)
  })

  test("measures a data url that is not base64 by its payload", () => {
    expect(attachmentBytes("data:image/svg+xml,<svg/>")).toBe(6)
  })
})

describe("image attachment", () => {
  test("inlines a payload at the bound and drops the one past it", () => {
    const atBound = "A".repeat(TOOL_ATTACHMENT_INLINE_MAX_BYTES)
    const pastBound = "A".repeat(TOOL_ATTACHMENT_INLINE_MAX_BYTES + 1)

    expect(imageAttachment({ mime: "image/png", data: atBound })).toMatchObject({
      kind: "inline",
      url: `data:image/png;base64,${atBound}`,
    })
    expect(imageAttachment({ mime: "image/png", data: pastBound })).toEqual({
      kind: "unretained",
      mime: "image/png",
      bytes: 98_304,
    })
  })

  test("keeps a workspace path by location and everything else by value", () => {
    expect(imageAttachment({ mime: "image/png", data: PNG, root: "/repo", sourcePath: "/repo/docs/a.png", filename: "a.png" })).toEqual({
      kind: "workspace-file",
      mime: "image/png",
      path: "docs/a.png",
      sourcePath: "/repo/docs/a.png",
      filename: "a.png",
    })
    expect(imageAttachment({ mime: "image/png", data: PNG, root: "/repo", sourcePath: "/tmp/a.png" })).toMatchObject({
      kind: "inline",
      url: `data:image/png;base64,${PNG}`,
    })
  })
})
