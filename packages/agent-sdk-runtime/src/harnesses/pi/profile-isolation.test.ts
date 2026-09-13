import { afterEach, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PiHarnessAdapter } from "./index"
import { createMemoryRuntimeStore } from "../../stores/memory"

/**
 * Pi's profile holds `models.json`, and that file carries the broker
 * placeholder. Two workspaces sharing one profile means the one that applied
 * last hands its binding to the other's turns — and the broker accepts it,
 * because the placeholder is valid, just not this workspace's.
 */
const previousAgentDir = process.env.PI_CODING_AGENT_DIR
let root = ""

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true })
  root = ""
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir
})

function projection(baseUrl: string, placeholder: string) {
  return {
    anthropic: {
      baseUrl,
      placeholder,
      authMode: "bearer" as const,
      expiresAt: Date.now() + 60 * 60 * 1000,
    },
  }
}

async function applied(options: { storeRoot?: string; workspaceId?: string }, baseUrl: string, placeholder: string) {
  const adapter = new PiHarnessAdapter({ store: createMemoryRuntimeStore(), ...options })
  await adapter.applyConfig({ auth: projection(baseUrl, placeholder) })
  return adapter
}

async function modelsFileUnder(dir: string) {
  const found: string[] = []
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.name === "models.json") found.push(path.join(entry.parentPath ?? dir, entry.name))
  }
  return found
}

test("two workspaces with their own store roots never share a models.json", async () => {
  delete process.env.PI_CODING_AGENT_DIR
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-profile-"))
  const a = path.join(root, "ws-a")
  const b = path.join(root, "ws-b")

  const first = await applied({ storeRoot: a }, "http://127.0.0.1:2595/bindings/aaa", "placeholder-a")
  const second = await applied({ storeRoot: b }, "http://127.0.0.1:2595/bindings/bbb", "placeholder-b")
  try {
    const written = await modelsFileUnder(root)
    expect(written).toHaveLength(2)
    const [contentA, contentB] = await Promise.all(written.sort().map((file) => fs.readFile(file, "utf8")))
    expect(contentA).toContain("placeholder-a")
    expect(contentA).not.toContain("placeholder-b")
    expect(contentB).toContain("placeholder-b")
    expect(contentB).not.toContain("placeholder-a")
  } finally {
    await first.dispose()
    await second.dispose()
  }
})

test("two workspaces with no store root are separated by their workspace ids", async () => {
  delete process.env.PI_CODING_AGENT_DIR
  // Observed rather than written: the fallback is rooted at the operator's own
  // home directory, and a test must not write a placeholder into it.
  const written: string[] = []
  const mkdir = spyOn(fs, "mkdir").mockImplementation(async () => undefined)
  const writeFile = spyOn(fs, "writeFile").mockImplementation(async () => undefined)
  const rename = spyOn(fs, "rename").mockImplementation(async (_from, to) => { written.push(String(to)) })
  const rm = spyOn(fs, "rm").mockImplementation(async () => undefined)
  try {
    const first = await applied({ workspaceId: "ws_a" }, "http://127.0.0.1:2595/bindings/aaa", "placeholder-a")
    const second = await applied({ workspaceId: "ws_b" }, "http://127.0.0.1:2595/bindings/bbb", "placeholder-b")
    await first.dispose()
    await second.dispose()
  } finally {
    mkdir.mockRestore()
    writeFile.mockRestore()
    rename.mockRestore()
    rm.mockRestore()
  }

  const models = [...new Set(written.filter((file) => file.endsWith("models.json")))]
  expect(models).toHaveLength(2)
  for (const file of models) expect(file).toContain(path.join(".claxedo", "pi", "agent"))
})
