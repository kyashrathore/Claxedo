import { describe, expect, test } from "bun:test"
import { imagePreviewUrl } from "./file-preview"

describe("imagePreviewUrl", () => {
  test("uses the server-provided image MIME type for binary content", () => {
    expect(
      imagePreviewUrl({
        path: "assets/photo.bin",
        binary: { content: "aW1hZ2U=", encoding: "base64", mimeType: "image/png" },
      }),
    ).toBe("data:image/png;base64,aW1hZ2U=")
  })

  test("falls back to the file extension when the binary MIME type is generic", () => {
    expect(
      imagePreviewUrl({
        path: "assets/photo.webp",
        binary: { content: "aW1hZ2U=", encoding: "base64", mimeType: "application/octet-stream" },
      }),
    ).toBe("data:image/webp;base64,aW1hZ2U=")
  })

  test("encodes text SVGs as image data URLs", () => {
    expect(imagePreviewUrl({ path: "logo.svg", text: '<svg viewBox="0 0 1 1"></svg>' })).toBe(
      "data:image/svg+xml;charset=utf-8,%3Csvg%20viewBox%3D%220%200%201%201%22%3E%3C%2Fsvg%3E",
    )
  })

  test("does not preview unrelated binary files", () => {
    expect(
      imagePreviewUrl({
        path: "archive.zip",
        binary: { content: "emlw", encoding: "base64", mimeType: "application/zip" },
      }),
    ).toBeUndefined()
  })

  test("does not interpret unencoded binary content as base64", () => {
    expect(
      imagePreviewUrl({
        path: "photo.png",
        binary: { content: "not-base64", mimeType: "image/png" },
      }),
    ).toBeUndefined()
  })
})
