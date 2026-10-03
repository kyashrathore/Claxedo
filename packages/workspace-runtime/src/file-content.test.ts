import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { FILE_CONTENT_MAX_BYTES, FileContentError, readFileContent } from "./file-content"

let directory: string
beforeAll(async () => { directory = await mkdtemp(path.join(tmpdir(), "file-content-")) })
afterAll(async () => { await rm(directory, { recursive: true, force: true }) })

async function refusal(file: string) {
  const error = await readFileContent(file).then(() => undefined, (cause: unknown) => cause)
  expect(error).toBeInstanceOf(FileContentError)
  return (error as FileContentError).refusal
}

test("a file over the cap is refused from its size alone, and one at the cap is read", async () => {
  const huge = path.join(directory, "capture.mov")
  await writeFile(huge, "")
  await truncate(huge, 400 * 1024 * 1024)
  expect(await refusal(huge)).toBe("too_large")

  const atCap = path.join(directory, "at-cap.txt")
  await writeFile(atCap, Buffer.alloc(FILE_CONTENT_MAX_BYTES, "a"))
  const read = await readFileContent(atCap)
  expect(read.type).toBe("text")
  expect(read.content.length).toBe(FILE_CONTENT_MAX_BYTES)
})

test("a non-image binary carries no bytes, an image carries base64", async () => {
  const archive = path.join(directory, "bundle.zip")
  await writeFile(archive, Buffer.from([80, 75, 3, 4, 0, 0, 255]))
  expect(await readFileContent(archive)).toEqual({ type: "binary", content: "" })

  const image = path.join(directory, "shot.PNG")
  const bytes = Buffer.from([137, 80, 78, 71, 0, 255])
  await writeFile(image, bytes)
  expect(await readFileContent(image)).toEqual({ type: "binary", content: bytes.toString("base64"), encoding: "base64", mimeType: "image/png" })
})

test("a missing path and a directory are typed refusals", async () => {
  expect(await refusal(path.join(directory, "gone.md"))).toBe("missing")
  expect(await refusal(path.join(directory, "gone", "child.md"))).toBe("missing")
  await writeFile(path.join(directory, "plain.txt"), "plain")
  expect(await refusal(path.join(directory, "plain.txt", "child.md"))).toBe("missing")
  expect(await refusal(directory)).toBe("not_a_file")
})
