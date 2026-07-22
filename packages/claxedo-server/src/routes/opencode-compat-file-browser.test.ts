import fs from "fs"
import os from "os"
import path from "path"
import { afterEach, describe, expect, test } from "vitest"
import { fileContentBody } from "./opencode-compat-file-browser"

const scratch: string[] = []

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })))
})

describe("fileContentBody", () => {
  test("returns binary files as explicitly encoded base64", async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "claxedo-file-content-"))
    scratch.push(directory)
    await fs.promises.writeFile(path.join(directory, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const result = await fileContentBody({
      req: {
        query: (key) => key === "directory" ? directory : key === "path" ? "image.png" : undefined,
        header: () => undefined,
      },
    })

    expect(result).toEqual({
      type: "binary",
      content: "iVBORw==",
      encoding: "base64",
    })
  })

  test("classifies UTF-8-valid content containing NUL bytes as binary", async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "claxedo-file-content-"))
    scratch.push(directory)
    await fs.promises.writeFile(path.join(directory, "image.bmp"), Buffer.from([0x42, 0x4d, 0x00, 0x00]))

    const result = await fileContentBody({
      req: {
        query: (key) => key === "directory" ? directory : key === "path" ? "image.bmp" : undefined,
        header: () => undefined,
      },
    })

    expect(result).toEqual({
      type: "binary",
      content: "Qk0AAA==",
      encoding: "base64",
    })
  })
})
