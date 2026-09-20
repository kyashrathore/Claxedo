import { cleanup, render } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FileMedia } from "@/ui/session-kit"

import { isReviewMediaFile } from "./review-content-requests"

afterEach(cleanup)

/** The shape `readFile` answers with, which the media view decodes. */
const PNG = { content: "iVBORw0KGgo=", mimeType: "image/png", encoding: "base64" }

async function settle(until: () => boolean) {
  for (let attempt = 0; attempt < 200 && !until(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
  return until()
}

/** Give a read that should never produce anything a fair chance to do so. */
const quiet = async () => {
  for (let tick = 0; tick < 5; tick++) await new Promise((resolve) => setTimeout(resolve, 5))
}

describe("which review rows are media", () => {
  it("previews images and audio", () => {
    expect(isReviewMediaFile("docs/logo.png")).toBe(true)
    expect(isReviewMediaFile("a/b/photo.JPEG")).toBe(true)
    expect(isReviewMediaFile("sounds/alert.mp3")).toBe(true)
  })

  it("leaves an SVG as a diff, because the media view cannot fetch one", () => {
    expect(isReviewMediaFile("icons/mark.svg")).toBe(false)
  })

  it("leaves ordinary source files alone", () => {
    expect(isReviewMediaFile("src/app.ts")).toBe(false)
    expect(isReviewMediaFile("README")).toBe(false)
  })
})

describe("the media body a review row mounts", () => {
  it("reads the file once and shows it", async () => {
    const readFile = vi.fn(async () => PNG)
    const screen = render(() => (
      <FileMedia media={{ mode: "auto", path: "logo.png", readFile }} fallback={() => <div data-testid="diff" />} />
    ))
    expect(await settle(() => !!screen.container.querySelector("img"))).toBe(true)
    expect(readFile).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId("diff")).toBeNull()
  })

  it("reports a failed read instead of waiting forever", async () => {
    const onError = vi.fn()
    const readFile = vi.fn(async () => {
      throw new Error("unreachable")
    })
    render(() => (
      <FileMedia media={{ mode: "auto", path: "logo.png", readFile, onError }} fallback={() => <div data-testid="diff" />} />
    ))
    expect(await settle(() => onError.mock.calls.length > 0)).toBe(true)
    expect(onError).toHaveBeenCalledWith({ kind: "image" })
  })

  it("does not read a deleted file", async () => {
    const readFile = vi.fn(async () => PNG)
    render(() => (
      <FileMedia media={{ mode: "auto", path: "logo.png", deleted: true, readFile }} fallback={() => <div data-testid="diff" />} />
    ))
    await quiet()
    expect(readFile).not.toHaveBeenCalled()
  })

  it("drops a read still in flight when the row is released", async () => {
    let settleRead: ((value: typeof PNG) => void) | undefined
    const readFile = vi.fn(() => new Promise<typeof PNG>((resolve) => { settleRead = resolve }))
    const screen = render(() => (
      <FileMedia media={{ mode: "auto", path: "logo.png", readFile }} fallback={() => <div data-testid="diff" />} />
    ))
    expect(await settle(() => !!settleRead)).toBe(true)

    // Scrolling the row out of the engine's range disposes this body. The same
    // answer would have produced an <img> had it arrived a moment earlier.
    cleanup()
    settleRead!(PNG)
    await quiet()
    expect(screen.container.querySelector("img")).toBeNull()
  })
})
