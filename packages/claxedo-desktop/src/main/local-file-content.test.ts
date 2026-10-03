import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { readLocalFileContent } from "./local-file-content"

let directory: string
beforeAll(async () => { directory = await mkdtemp(path.join(tmpdir(), "local-file-content-")) })
afterAll(async () => { await rm(directory, { recursive: true, force: true }) })

test("a local document and image use the canonical file-content contract", async () => {
  const document = path.join(directory, "verification details.md")
  await writeFile(document, "Verified artifact.\n")
  expect(await readLocalFileContent(document)).toEqual({ type: "text", content: "Verified artifact." })
  const image = path.join(directory, "preview.png")
  const bytes = Buffer.from([137, 80, 78, 71, 0, 255])
  await writeFile(image, bytes)
  expect(await readLocalFileContent(image)).toEqual({ type: "binary", content: bytes.toString("base64"), encoding: "base64", mimeType: "image/png" })
})

test("relative paths, traversal and directories are refused", async () => {
  await expect(readLocalFileContent("README.md")).rejects.toThrow("not absolute")
  await expect(readLocalFileContent(path.join(directory, "folder") + "/../secret.txt")).rejects.toThrow("leaves the directory")
  await expect(readLocalFileContent(directory)).rejects.toThrow("not a file")
})

test("a missing artifact is reported as missing and can be read once restored", async () => {
  const document = path.join(directory, "restored.md")
  await expect(readLocalFileContent(document)).rejects.toThrow("does not exist")
  await writeFile(document, "Restored")
  expect(await readLocalFileContent(document)).toEqual({ type: "text", content: "Restored" })
})
