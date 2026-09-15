import { describe, expect, test, vi } from "vitest"
import { TASKS_BOUNDS } from "@claxedo/tasks"
import { draftImageUrl, imageRefusalMessage, isImageRefusal, readImageDraft } from "./image-drafts"

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])

const neverShrinks = vi.fn(async () => undefined)

describe("readImageDraft", () => {
  test("carries an image as its type and standard base64, never a data URL", async () => {
    const read = await readImageDraft(new File([PNG], "shot.png", { type: "image/png" }), neverShrinks)
    expect(read).toEqual({ filename: "shot.png", mime: "image/png", data: "iVBORw==" })
    expect(neverShrinks).not.toHaveBeenCalled()
    if (!isImageRefusal(read)) expect(draftImageUrl(read)).toBe("data:image/png;base64,iVBORw==")
  })

  test("names an undeclared type from the extension, and refuses anything that is not one of the four image types", async () => {
    expect(await readImageDraft(new File([PNG], "shot.PNG"), neverShrinks)).toMatchObject({ mime: "image/png" })
    expect(await readImageDraft(new File([PNG], "diagram.svg", { type: "image/svg+xml" }), neverShrinks)).toEqual({
      filename: "diagram.svg",
      reason: "not_an_image",
    })
    expect(await readImageDraft(new File(["hello"], "notes.txt", { type: "text/plain" }), neverShrinks)).toEqual({
      filename: "notes.txt",
      reason: "not_an_image",
    })
  })

  test("an image over the cap is shrunk, stored under the encoding it now has, and renamed for it", async () => {
    const big = new File([new Uint8Array(TASKS_BOUNDS.taskAttachmentMaxBytes + 1)], "retina.png", { type: "image/png" })
    const shrink = vi.fn(async () => new Blob([Uint8Array.from([0x52, 0x49, 0x46, 0x46])], { type: "image/webp" }))
    expect(await readImageDraft(big, shrink)).toEqual({ filename: "retina.webp", mime: "image/webp", data: "UklGRg==" })
    expect(shrink).toHaveBeenCalledWith(big, TASKS_BOUNDS.taskAttachmentMaxBytes)
  })

  test("an image the shrink cannot bring under the cap is refused as too large, as is one it hands back still over it", async () => {
    const big = new File([new Uint8Array(TASKS_BOUNDS.taskAttachmentMaxBytes + 1)], "retina.png", { type: "image/png" })
    expect(await readImageDraft(big, neverShrinks)).toEqual({ filename: "retina.png", reason: "too_large" })
    const stillOver = async () => new Blob([new Uint8Array(TASKS_BOUNDS.taskAttachmentMaxBytes + 1)], { type: "image/jpeg" })
    expect(await readImageDraft(big, stillOver)).toEqual({ filename: "retina.png", reason: "too_large" })
    const throwing = async () => {
      throw new Error("no canvas")
    }
    expect(await readImageDraft(big, throwing)).toEqual({ filename: "retina.png", reason: "too_large" })
  })

  test("every refusal has a sentence that names the file", () => {
    expect(imageRefusalMessage({ filename: "a.svg", reason: "not_an_image" })).toContain("a.svg")
    expect(imageRefusalMessage({ filename: "b.png", reason: "too_large" })).toContain("1.5 MiB")
    expect(imageRefusalMessage({ filename: "c.png", reason: "unreadable" })).toContain("c.png")
  })
})
