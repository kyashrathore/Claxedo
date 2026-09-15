import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import type { TaskAttachment } from "@claxedo/tasks"
import { TaskAttachmentGallery } from "./task-attachments"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const BEFORE: TaskAttachment = { id: "tat_1", filename: "before.png", mime: "image/png", size: 4, createdAt: 10 }
const AFTER: TaskAttachment = { id: "tat_2", filename: "after.webp", mime: "image/webp", size: 4, createdAt: 10 }
const IMAGES = [BEFORE, AFTER]

/** jsdom has no object URLs; the stub names each by the blob's type so the rendered source can be checked. */
function stubObjectUrls() {
  const revoked: string[] = []
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: (blob: Blob) => `blob:${blob.type}`,
    revokeObjectURL: (url: string) => void revoked.push(url),
  })
  return revoked
}

describe("TaskAttachmentGallery", () => {
  test("fetches each image through the reader it was given and shows it under its name", async () => {
    stubObjectUrls()
    const read = vi.fn(async (attachmentId: string) => {
      const image = IMAGES.find((entry) => entry.id === attachmentId)
      return new Blob([Uint8Array.from([1, 2, 3, 4])], { type: image?.mime })
    })
    render(() => <TaskAttachmentGallery attachments={IMAGES} read={read} />)

    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2))
    const [first, second] = screen.getAllByRole("img")
    expect(first?.getAttribute("src")).toBe("blob:image/png")
    expect(first?.getAttribute("alt")).toBe("before.png")
    expect(second?.getAttribute("src")).toBe("blob:image/webp")
    expect(screen.getByTestId("task-attachments").textContent).toContain("after.webp")
    expect(read.mock.calls.map(([id]) => id)).toEqual(["tat_1", "tat_2"])
  })

  test("gives the object URLs back when the gallery unmounts", async () => {
    const revoked = stubObjectUrls()
    const { unmount } = render(() => (
      <TaskAttachmentGallery attachments={IMAGES} read={async () => new Blob([], { type: "image/png" })} />
    ))
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2))

    unmount()
    expect(revoked).toEqual(["blob:image/png", "blob:image/png"])
  })

  test("gives the object URL back when the read finishes after unmount", async () => {
    const revoked = stubObjectUrls()
    let release!: () => void
    const pending = new Promise<Blob>((resolve) => {
      release = () => resolve(new Blob([], { type: "image/png" }))
    })
    const { unmount } = render(() => <TaskAttachmentGallery attachments={[BEFORE]} read={() => pending} />)

    unmount()
    release()
    await vi.waitFor(() => expect(revoked).toEqual(["blob:image/png"]))
  })

  test("a read the server refuses is reported beside the name rather than as a broken image", async () => {
    stubObjectUrls()
    render(() => (
      <TaskAttachmentGallery
        attachments={[BEFORE]}
        read={async () => {
          throw new Error("Attachment tat_1 was not found on task tsk_1")
        }}
      />
    ))
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("before.png could not be loaded."))
    expect(screen.queryByRole("img")).toBeNull()
  })

  test("renders nothing for a task with no images", () => {
    render(() => <TaskAttachmentGallery attachments={[]} read={async () => new Blob()} />)
    expect(screen.queryByTestId("task-attachments")).toBeNull()
  })
})
