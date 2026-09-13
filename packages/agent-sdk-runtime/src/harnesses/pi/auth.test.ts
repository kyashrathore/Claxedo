import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { retainPiAuth, writePiAuth } from "./auth"
import { installFakePiRpc } from "../../test-utils/fake-pi-rpc.mjs"
import { PiHarnessAdapter } from "./index"
import { createMemoryRuntimeStore } from "../../stores/memory"

test("a profile reacquired during cleanup serializes its new credential write after removal", async () => {
  const f = await installFakePiRpc()
  const a = retainPiAuth(f.agentDir)
  const file = path.join(f.agentDir, "auth.json")
  const removing = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const rm = fs.rm
  const removal = spyOn(fs, "rm").mockImplementation(async (target, options) => {
    if (target === file) {
      removing.resolve()
      await gate.promise
    }
    return rm(target, options)
  })
  let b: ReturnType<typeof retainPiAuth> | undefined
  try {
    await a.write({ openai: { type: "api_key", key: "old" } })
    const released = a.release()
    await removing.promise
    b = retainPiAuth(path.join(f.agentDir, "."))
    const written = b.write({ openai: { type: "api_key", key: "new" } })
    gate.resolve()
    await Promise.all([released, written])
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ openai: { type: "api_key", key: "new" } })
    await b.release()
    expect(
      await fs.access(file).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
  } finally {
    gate.resolve()
    removal.mockRestore()
    await a.release()
    await b?.release()
    await f.dispose()
  }
})

test("a shared managed profile survives until its final adapter is disposed", async () => {
  const f = await installFakePiRpc()
  const create = () =>
    new PiHarnessAdapter({ binary: f.binary, agentDir: f.agentDir, store: createMemoryRuntimeStore() })
  const a = create()
  const b = create()
  const config = { auth: {} }
  const file = path.join(f.agentDir, "auth.json")
  try {
    await Promise.all([a.applyConfig(config), b.applyConfig(config)])
    await a.dispose()
    await a.dispose()
    await b.applyConfig(config)
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({})
    await b.dispose()
    expect(
      await fs.access(file).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
  } finally {
    await Promise.all([a.dispose(), b.dispose()])
    await f.dispose()
  }
})

test("the first sync revokes a stale profile left on disk", async () => {
  const f = await installFakePiRpc()
  await writePiAuth(f.agentDir, { openai: { type: "api_key", key: "stale" } })
  const adapter = new PiHarnessAdapter({
    binary: f.binary,
    agentDir: f.agentDir,
    store: createMemoryRuntimeStore(),
  })
  const file = path.join(f.agentDir, "auth.json")
  try {
    await adapter.applyConfig({ auth: {} })
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({})
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
  } finally {
    await adapter.dispose()
    await f.dispose()
  }
})

const piProjection = {
  baseUrl: "http://127.0.0.1:2595/bindings/7c2d",
  placeholder: "signed-placeholder",
  authMode: "bearer" as const,
  expiresAt: 1_800_000_000_000,
  apiPath: "/v1",
}

test("a bound account reaches Pi as a models.json overlay and never as a key", async () => {
  const f = await installFakePiRpc()
  const adapter = new PiHarnessAdapter({
    binary: f.binary,
    agentDir: f.agentDir,
    store: createMemoryRuntimeStore(),
  })
  const models = path.join(f.agentDir, "models.json")
  try {
    await adapter.applyConfig({ auth: { anthropic: piProjection, openai: piProjection } })

    expect(JSON.parse(await fs.readFile(models, "utf8"))).toEqual({
      providers: {
        // Pi's own anthropic base URL is the origin; its openai base URL is the API root.
        anthropic: { baseUrl: "http://127.0.0.1:2595/bindings/7c2d", apiKey: "signed-placeholder" },
        openai: { baseUrl: "http://127.0.0.1:2595/bindings/7c2d/v1", apiKey: "signed-placeholder" },
      },
    })
    expect((await fs.stat(models)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await fs.readFile(path.join(f.agentDir, "auth.json"), "utf8"))).toEqual({})

    await adapter.createSession(f.agentDir)
    const launched = JSON.parse(await fs.readFile(path.join(f.agentDir, "launch-env.json"), "utf8"))
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY"]) {
      expect(launched).not.toHaveProperty(name)
    }
  } finally {
    await adapter.dispose()
    await f.dispose()
  }
})

test("a projection for another harness leaves Pi on its own machine login", async () => {
  const f = await installFakePiRpc()
  const adapter = new PiHarnessAdapter({
    binary: f.binary,
    agentDir: f.agentDir,
    store: createMemoryRuntimeStore(),
  })
  try {
    await adapter.applyConfig({ auth: { "claude-sdk": piProjection, "cursor-sdk": piProjection } })

    expect(JSON.parse(await fs.readFile(path.join(f.agentDir, "models.json"), "utf8"))).toEqual({ providers: {} })
  } finally {
    await adapter.dispose()
    await f.dispose()
  }
})

test("an unavailable account fails the turn instead of running on the machine login", async () => {
  const f = await installFakePiRpc()
  const adapter = new PiHarnessAdapter({
    binary: f.binary,
    agentDir: f.agentDir,
    store: createMemoryRuntimeStore(),
  })
  try {
    await adapter.applyConfig({ auth: { anthropic: { unavailable: true, reason: "auth_failed" } } })

    expect(JSON.parse(await fs.readFile(path.join(f.agentDir, "models.json"), "utf8"))).toEqual({ providers: {} })
    await expect(adapter.createSession(f.agentDir))
      .rejects.toThrow("the pi credential selected for this workspace cannot be used: auth_failed")
  } finally {
    await adapter.dispose()
    await f.dispose()
  }
})

test("an explicit native profile overrides the store default and is scrubbed on disposal", async () => {
  const f = await installFakePiRpc()
  const previous = process.env.PI_CODING_AGENT_DIR
  let adapter: PiHarnessAdapter
  try {
    process.env.PI_CODING_AGENT_DIR = f.agentDir
    adapter = new PiHarnessAdapter({
      binary: f.binary,
      storeRoot: path.join(f.agentDir, "store"),
      store: createMemoryRuntimeStore(),
    })
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
  }
  const file = path.join(f.agentDir, "auth.json")
  try {
    await adapter.applyConfig({ auth: {} })
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({})
    await adapter.dispose()
    expect(
      await fs.access(file).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
  } finally {
    await adapter.dispose()
    await f.dispose()
  }
})
