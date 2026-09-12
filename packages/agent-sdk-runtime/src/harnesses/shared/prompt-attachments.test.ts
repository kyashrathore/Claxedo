import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { removeTestTempDir } from "./test-temp-dir"
import {
  attachmentPathLines,
  deliverPromptAttachments,
  isPromptImageMime,
  materializeAttachments,
  promptAttachments,
  promptImageAttachments,
} from "./prompt-attachments"

const PNG = Buffer.from("iVBORw0KGgo=", "base64").toString("base64")
const MP4 = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]).toString("base64")

const imagePart = {
  type: "file",
  mime: "image/png",
  filename: "shot.png",
  url: `data:image/png;base64,${PNG}`,
}
const videoPart = {
  type: "file",
  mime: "video/mp4",
  filename: "clip.mp4",
  url: `data:video/mp4;base64,${MP4}`,
}
const mentionPart = {
  type: "file",
  mime: "text/plain",
  filename: "app.ts",
  url: "file:///workspace/app.ts",
}

let directory = ""
const attachmentDirectory = () => path.join(directory, ".claxedo", "attachments")

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-attachments-"))
})

afterEach(() => {
  removeTestTempDir(directory)
})

describe("prompt attachments", () => {
  test("reads inline bytes out of a file part and skips path references", () => {
    expect(promptAttachments([{ type: "text", text: "look" }, imagePart, mentionPart])).toEqual([
      { mime: "image/png", base64: PNG, url: imagePart.url, filename: "shot.png" },
    ])
  })

  test("names the four image types a harness image input accepts", () => {
    expect(["image/png", "image/jpeg", "image/gif", "image/webp"].every(isPromptImageMime)).toBe(true)
    expect(isPromptImageMime("image/svg+xml")).toBe(false)
    expect(isPromptImageMime("video/mp4")).toBe(false)
  })

  test("refuses a data url that is not base64", () => {
    expect(promptAttachments([{ type: "file", mime: "text/plain", url: "data:text/plain,hello" }])).toEqual([])
  })

  test("writes an attachment under the workspace and reuses the path for the same bytes", async () => {
    const first = await materializeAttachments({ directory, attachments: promptAttachments([videoPart]) })
    const second = await materializeAttachments({ directory, attachments: promptAttachments([videoPart]) })
    expect(first).toHaveLength(1)
    expect(second[0]?.path).toBe(first[0].path)
    const target = first[0].path
    expect(path.dirname(target)).toBe(attachmentDirectory())
    expect(path.basename(target).endsWith("-clip.mp4")).toBe(true)
    expect(fs.readFileSync(target).toString("base64")).toBe(MP4)
  })

  test("keeps a traversing filename inside the attachment directory", async () => {
    const written = await materializeAttachments({
      directory,
      attachments: promptAttachments([{ ...videoPart, filename: "a/../../../escape.mp4" }]),
    })
    expect(path.dirname(written[0].path)).toBe(attachmentDirectory())
    expect(path.basename(written[0].path).endsWith("-escape.mp4")).toBe(true)
    expect(fs.existsSync(path.join(directory, "..", "escape.mp4"))).toBe(false)
  })

  test("materializes every attachment and names each path on its own line", async () => {
    const delivery = await deliverPromptAttachments({
      parts: [{ type: "text", text: "review this" }, imagePart, videoPart],
      directory,
    })
    expect(delivery.attachments.map((item) => item.mime)).toEqual(["image/png", "video/mp4"])
    expect(delivery.text).toBe([
      "review this",
      `Attached file (image/png): ${delivery.attachments[0].path}`,
      `Attached file (video/mp4): ${delivery.attachments[1].path}`,
    ].join("\n"))
    expect(fs.readFileSync(delivery.attachments[1].path).toString("base64")).toBe(MP4)
  })

  test("offers only the image attachments to a harness with a native image input", async () => {
    const delivery = await deliverPromptAttachments({
      parts: [imagePart, videoPart],
      directory,
    })
    expect(promptImageAttachments(delivery).map((item) => item.mime)).toEqual(["image/png"])
    expect(attachmentPathLines(delivery.attachments)).toHaveLength(2)
  })

  test("ignores the attachment directory it writes into so the workspace stays clean", async () => {
    await materializeAttachments({ directory, attachments: promptAttachments([imagePart]) })
    expect(fs.readFileSync(path.join(attachmentDirectory(), ".gitignore"), "utf8")).toBe("*\n")
  })

  test("keeps the ignore file the workspace already had instead of rewriting it", async () => {
    await materializeAttachments({ directory, attachments: promptAttachments([imagePart]) })
    const ignore = path.join(attachmentDirectory(), ".gitignore")
    expect(fs.readFileSync(ignore, "utf8")).toBe("*\n")
    fs.writeFileSync(ignore, "*\n!keep.png\n")
    await materializeAttachments({ directory, attachments: promptAttachments([videoPart]) })
    expect(fs.readFileSync(ignore, "utf8")).toBe("*\n!keep.png\n")
  })

  test("leaves a text-only prompt and its directory untouched", async () => {
    const delivery = await deliverPromptAttachments({
      parts: [{ type: "text", text: "just words" }],
      directory,
    })
    expect(delivery).toEqual({ text: "just words", attachments: [] })
    expect(fs.existsSync(path.join(directory, ".claxedo"))).toBe(false)
  })
})
