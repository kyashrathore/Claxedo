import { afterEach, describe, expect, test } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { localUsageHostId } from "./host-id"

const roots: string[] = []
const previous = process.env.CLAXEDO_DATA_DIR

afterEach(async () => {
  if (previous === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previous
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("local usage host identity", () => {
  test("is stable within one data root and isolated across data roots", async () => {
    const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), "usage-host-a-"))
    const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), "usage-host-b-"))
    roots.push(firstRoot, secondRoot)

    process.env.CLAXEDO_DATA_DIR = firstRoot
    const first = await localUsageHostId()
    expect(await localUsageHostId()).toBe(first)

    process.env.CLAXEDO_DATA_DIR = secondRoot
    const second = await localUsageHostId()
    expect(second).not.toBe(first)

    process.env.CLAXEDO_DATA_DIR = firstRoot
    expect(await localUsageHostId()).toBe(first)
  })
})
