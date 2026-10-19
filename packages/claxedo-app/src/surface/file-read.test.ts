/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import { SURFACE_FILE_EVENT_MAX_BYTES } from "@claxedo/plugin-api/surface"
import { FILE_PASTE_SCOPE, isAccepted, pasteTarget, readPickedFiles, type FilePickRules, type FileReading } from "./file-read"

const fakeBase64 = async (blob: Blob) => `b64:${blob.size}`

function reading(fit: FileReading["fit"] = async () => undefined): FileReading {
  return { fit, base64: fakeBase64 }
}

const rules: FilePickRules = { accept: ["image/png", "image/jpeg", ".pdf"], maxBytes: 100, maxFiles: 3, fitImages: false }

const file = (name: string, size: number, type = "") => new File([new Uint8Array(size)], name, { type })

describe("isAccepted", () => {
  test("matches a type, a wildcard type and an extension, reading an image's type from its name when undeclared", () => {
    expect(isAccepted(["image/*"], { name: "a.webp", type: "" })).toBe(true)
    expect(isAccepted(["image/png"], { name: "shot.PNG", type: "" })).toBe(true)
    expect(isAccepted([".pdf"], { name: "Spec.PDF", type: "application/pdf" })).toBe(true)
    expect(isAccepted(["image/png"], { name: "a.svg", type: "image/svg+xml" })).toBe(false)
    expect(isAccepted(["image/*"], { name: "notes.txt", type: "text/plain" })).toBe(false)
  })
})

describe("readPickedFiles", () => {
  test("hands over each accepted file's name, type, size and base64 bytes", async () => {
    const pick = await readPickedFiles([file("a.png", 10, "image/png"), file("spec.pdf", 20, "application/pdf")], rules, reading())
    expect(pick).toEqual({
      files: [
        { name: "a.png", mimeType: "image/png", size: 10, dataBase64: "b64:10" },
        { name: "spec.pdf", mimeType: "application/pdf", size: 20, dataBase64: "b64:20" },
      ],
      refused: [],
    })
  })

  test("refuses a type outside accept, a file over maxBytes and every file past maxFiles accepted ones, by name", async () => {
    const files = [file("notes.txt", 5, "text/plain"), file("big.png", 101, "image/png"), file("a.png", 5, "image/png"), file("b.png", 5, "image/png"), file("c.png", 5, "image/png"), file("d.png", 5, "image/png")]
    const pick = await readPickedFiles(files, rules, reading())
    expect(pick.files.map((picked) => picked.name)).toEqual(["a.png", "b.png", "c.png"])
    expect(pick.refused).toEqual([
      { name: "notes.txt", reason: "type" },
      { name: "big.png", reason: "size" },
      { name: "d.png", reason: "count" },
    ])
  })

})

describe("readPickedFiles sizes", () => {
  test("re-encodes an oversized image only when fitImages is on, and refuses one that does not fit", async () => {
    const fitted: string[] = []
    const fit: FileReading["fit"] = async (picked, maxBytes) => {
      fitted.push(`${picked.name}<=${maxBytes}`)
      return picked.name === "huge.png" ? undefined : { blob: new Blob([new Uint8Array(80)], { type: "image/webp" }), name: "big.webp", type: "image/webp" }
    }
    const files = [file("big.png", 500, "image/png"), file("huge.png", 900, "image/png"), file("big.pdf", 500, "application/pdf")]
    const pick = await readPickedFiles(files, { ...rules, fitImages: true }, reading(fit))
    expect(fitted).toEqual(["big.png<=100", "huge.png<=100"])
    expect(pick.files).toEqual([{ name: "big.webp", mimeType: "image/webp", size: 80, dataBase64: "b64:80" }])
    expect(pick.refused).toEqual([{ name: "huge.png", reason: "size" }, { name: "big.pdf", reason: "size" }])
  })

  test("refuses with size every file that would carry one event past 12 MiB", async () => {
    const share = Math.floor(SURFACE_FILE_EVENT_MAX_BYTES / 2)
    const pick = await readPickedFiles([file("a.png", share, "image/png"), file("b.png", share, "image/png"), file("c.png", share, "image/png")], { ...rules, maxBytes: share }, reading())
    expect(pick.files.map((picked) => picked.name)).toEqual(["a.png", "b.png"])
    expect(pick.refused).toEqual([{ name: "c.png", reason: "size" }])
  })
})

describe("pasteTarget", () => {
  type Node = { readonly name: string; closest(selector: string): Node | null }
  const section: Node = { name: "section", closest: () => null }
  const inside: Node = { name: "picker", closest: (selector) => (selector === FILE_PASTE_SCOPE ? section : null) }
  const alone: Node = { name: "lone picker", closest: () => null }

  test("listens on the picker itself, on its nearest Section or Card, or nowhere", () => {
    expect([pasteTarget("self", inside)?.name, pasteTarget("section", inside)?.name, pasteTarget(undefined, inside)]).toEqual(["picker", "section", undefined])
  })

  test("a section-wide paste with no Section or Card around it falls to the picker", () => {
    expect(pasteTarget("section", alone)?.name).toBe("lone picker")
  })
})
