import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createPiOptionsCache, type PiOptionsProbe } from "./options-cache"

let root: string
let agentDir: string
let directory: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-options-cache-"))
  agentDir = path.join(root, "agent")
  directory = path.join(root, "work")
  await fs.mkdir(agentDir)
  await fs.mkdir(directory)
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function counted(answer: (count: number) => PiOptionsProbe = (count) => ({ models: [{ id: `p/m${count}`, name: "M" }], thinking: [], selectedThinking: "off" })) {
  let count = 0
  return { probe: async () => answer(++count), count: () => count }
}

async function touch(file: string, content: string) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
}

describe("pi options cache", () => {
  test("a second read of the same model answers without probing", async () => {
    const cache = createPiOptionsCache(agentDir)
    const probe = counted()
    const first = await cache.read(directory, "p/m", probe.probe)
    expect(await cache.read(directory, "p/m", probe.probe)).toEqual(first)
    expect(probe.count()).toBe(1)
  })

  test("reads that arrive while a probe runs share it", async () => {
    const cache = createPiOptionsCache(agentDir)
    const probe = counted()
    await Promise.all([cache.read(directory, "p/m", probe.probe), cache.read(directory, "p/m", probe.probe)])
    expect(probe.count()).toBe(1)
  })

  test("another model, a workspace with its own .pi folder or a cleared cache probes again", async () => {
    const cache = createPiOptionsCache(agentDir)
    const probe = counted()
    await cache.read(directory, "p/m", probe.probe)
    await cache.read(directory, "p/other", probe.probe)
    const configured = path.join(root, "configured")
    await touch(path.join(configured, ".pi", "settings.json"), "{}")
    await cache.read(configured, "p/m", probe.probe)
    cache.clear()
    await cache.read(directory, "p/m", probe.probe)
    expect(probe.count()).toBe(4)
  })

  test("workspaces that see the same .pi folders share one answer", async () => {
    const cache = createPiOptionsCache(agentDir)
    const probe = counted()
    const sibling = path.join(root, "sibling")
    await fs.mkdir(sibling)
    await cache.read(directory, "p/m", probe.probe)
    await cache.read(sibling, "p/m", probe.probe)
    expect(probe.count()).toBe(1)
  })

  test("a change to a profile file Pi reads probes again", async () => {
    const cache = createPiOptionsCache(agentDir)
    const probe = counted()
    await cache.read(directory, "p/m", probe.probe)
    await touch(path.join(agentDir, "models.json"), "{}")
    await cache.read(directory, "p/m", probe.probe)
    await touch(path.join(directory, ".pi", "settings.json"), "{\"defaultModel\":\"m\"}")
    await cache.read(directory, "p/m", probe.probe)
    await touch(path.join(agentDir, "settings.json"), "{}")
    await cache.read(directory, "p/m", probe.probe)
    expect(probe.count()).toBe(4)
  })

  test("an answer read while a profile file changed is not kept", async () => {
    const cache = createPiOptionsCache(agentDir)
    let count = 0
    const probe = async () => {
      count++
      if (count === 1) await touch(path.join(agentDir, "auth.json"), "{}")
      return { models: [], thinking: [], selectedThinking: "off" }
    }
    await cache.read(directory, "p/m", probe)
    await cache.read(directory, "p/m", probe)
    await cache.read(directory, "p/m", probe)
    expect(count).toBe(2)
  })

  test("a failed probe is not kept", async () => {
    const cache = createPiOptionsCache(agentDir)
    let count = 0
    const probe = async () => {
      count++
      if (count === 1) throw new Error("pi exited")
      return { models: [], thinking: [], selectedThinking: "off" }
    }
    await expect(cache.read(directory, "p/m", probe)).rejects.toThrow("pi exited")
    await cache.read(directory, "p/m", probe)
    expect(count).toBe(2)
  })
})
