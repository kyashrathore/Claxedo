import { afterEach, expect, setDefaultTimeout, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PiHarnessAdapter } from "./index"
import { createMemoryRuntimeStore } from "../../stores/memory"
import { privateWriteBudgetMs } from "../../test-utils/private-write-budget"

// `applyConfig` replaces `auth.json` and `models.json`.
setDefaultTimeout(privateWriteBudgetMs(2))

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
  // The fallback is rooted at the operator's own home directory, which the
  // test points at scratch space rather than writing a placeholder into. Bun's
  // `os.homedir()` does not read `HOME`, so the function itself is replaced.
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-profile-home-"))
  const homedir = spyOn(os, "homedir").mockReturnValue(root)
  try {
    const first = await applied({ workspaceId: "ws_a" }, "http://127.0.0.1:2595/bindings/aaa", "placeholder-a")
    const second = await applied({ workspaceId: "ws_b" }, "http://127.0.0.1:2595/bindings/bbb", "placeholder-b")
    try {
      const models = await modelsFileUnder(path.join(root, ".claxedo", "pi", "agent"))
      expect(models).toHaveLength(2)
      expect(new Set(models.map((file) => path.dirname(file))).size).toBe(2)
    } finally {
      await first.dispose()
      await second.dispose()
    }
  } finally {
    homedir.mockRestore()
  }
})

test("a store root outranks PI_CODING_AGENT_DIR, so env cannot un-scope a workspace", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-profile-"))
  const shared = path.join(root, "shared")
  const scoped = path.join(root, "ws-a")
  // One variable in the operator's shell would otherwise put every workspace's
  // placeholder back in one file, which is the fault the scoping exists for.
  process.env.PI_CODING_AGENT_DIR = shared

  const adapter = await applied({ storeRoot: scoped }, "http://127.0.0.1:2595/bindings/aaa", "placeholder-a")
  try {
    expect(await modelsFileUnder(root)).toEqual([path.join(scoped, "pi", "agent", "models.json")])
  } finally {
    await adapter.dispose()
  }
})
