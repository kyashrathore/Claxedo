import { describe, expect, test } from "bun:test"
import { timelineExternalSourceClickTarget } from "./timeline-file-paths"

function click(target: Element, overrides: Partial<MouseEvent> = {}) {
  return {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target,
    ...overrides,
  } as MouseEvent
}

describe("timeline external image links", () => {
  test("routes linked remote images to the workspace browser", () => {
    const anchor = document.createElement("a")
    anchor.href = "https://cdn.example.com/assets/photo?id=123"
    const image = document.createElement("img")
    anchor.append(image)

    expect(timelineExternalSourceClickTarget(click(image))).toBe("https://cdn.example.com/assets/photo?id=123")
  })

  test("recognizes direct image URLs while leaving ordinary web links alone", () => {
    const imageLink = document.createElement("a")
    imageLink.href = "https://cdn.example.com/photo.webp?size=large"
    const imageFormatPathLink = document.createElement("a")
    imageFormatPathLink.href = "https://placehold.co/600x400/png"
    const webLink = document.createElement("a")
    webLink.href = "https://example.com/article"

    expect(timelineExternalSourceClickTarget(click(imageLink))).toBe("https://cdn.example.com/photo.webp?size=large")
    expect(timelineExternalSourceClickTarget(click(imageFormatPathLink))).toBe("https://placehold.co/600x400/png")
    expect(timelineExternalSourceClickTarget(click(webLink))).toBeUndefined()
  })

  test("routes extensionless source attachments rendered as file-part links", () => {
    const source = document.createElement("a")
    source.dataset.slot = "file-part-link"
    source.href = "https://cdn.example.com/download?asset=image-123"
    const label = document.createElement("span")
    label.textContent = "Generated source"
    source.append(label)

    expect(timelineExternalSourceClickTarget(click(label))).toBe(
      "https://cdn.example.com/download?asset=image-123",
    )
  })

  test("preserves modified-click browser behavior", () => {
    const anchor = document.createElement("a")
    anchor.href = "https://cdn.example.com/photo.png"

    expect(timelineExternalSourceClickTarget(click(anchor, { metaKey: true }))).toBeUndefined()
  })
})
