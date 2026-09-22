import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { retainPiAuth } from "./auth"
import { installFakePiRpc } from "../../test-utils/fake-pi-rpc.mjs"
import { PiHarnessAdapter } from "./index"
import { createMemoryRuntimeStore } from "../../stores/memory"

test("a profile reacquired during cleanup serializes its new credential write after removal", async () => {
  const f = await installFakePiRpc()
  const a = retainPiAuth(f.agentDir)
  const file = path.join(f.agentDir, "models.json")
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
    await a.write({ openai: { baseUrl: "http://127.0.0.1:2595/bindings/old", apiKey: "old" } })
    const released = a.release()
    await removing.promise
    b = retainPiAuth(path.join(f.agentDir, "."))
    const written = b.write({ openai: { baseUrl: "http://127.0.0.1:2595/bindings/new", apiKey: "new" } })
    gate.resolve()
    await Promise.all([released, written])
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
      providers: { openai: { baseUrl: "http://127.0.0.1:2595/bindings/new", apiKey: "new" } },
    })
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
  const file = path.join(f.agentDir, "models.json")
  try {
    await Promise.all([a.applyConfig(config), b.applyConfig(config)])
    await a.dispose()
    await a.dispose()
    await b.applyConfig(config)
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ providers: {} })
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
  await fs.mkdir(f.agentDir, { recursive: true })
  await fs.writeFile(
    path.join(f.agentDir, "auth.json"),
    JSON.stringify({ openai: { type: "api_key", key: "stale" } }),
  )
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
    // A login Pi stored for itself resolves ahead of the overlay, so the
    // profile's own credential file has to be empty for the placeholder to be
    // the only credential the process can send.
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

test("a projection for a vendor Pi cannot run leaves Pi on its own machine login", async () => {
  const f = await installFakePiRpc()
  const adapter = new PiHarnessAdapter({
    binary: f.binary,
    agentDir: f.agentDir,
    store: createMemoryRuntimeStore(),
  })
  try {
    // Cursor's login is Cursor's own service; Pi defines no provider it could
    // serve, so there is nothing to overlay and the process keeps its own login.
    await adapter.applyConfig({ auth: { "cursor-sdk": piProjection } })

    expect(JSON.parse(await fs.readFile(path.join(f.agentDir, "models.json"), "utf8"))).toEqual({ providers: {} })
  } finally {
    await adapter.dispose()
    await f.dispose()
  }
})

test("a Claude Code login binds Pi's Anthropic provider without being connected again", async () => {
  const f = await installFakePiRpc()
  const adapter = new PiHarnessAdapter({
    binary: f.binary,
    agentDir: f.agentDir,
    store: createMemoryRuntimeStore(),
  })
  try {
    // Stored under the harness that signed in, bound here because the broker
    // sends it to the same origin and paths an `anthropic` key goes to. This
    // is the same order the credential catalog counts Anthropic connected in.
    await adapter.applyConfig({ auth: { "claude-sdk": piProjection } })

    expect(JSON.parse(await fs.readFile(path.join(f.agentDir, "models.json"), "utf8"))).toEqual({
      providers: { anthropic: { baseUrl: "http://127.0.0.1:2595/bindings/7c2d", apiKey: "signed-placeholder" } },
    })
  } finally {
    await adapter.dispose()
    await f.dispose()
  }
})

test("a key pasted for the vendor outranks a subscription that belongs to another product", async () => {
  const f = await installFakePiRpc()
  const adapter = new PiHarnessAdapter({
    binary: f.binary,
    agentDir: f.agentDir,
    store: createMemoryRuntimeStore(),
  })
  try {
    await adapter.applyConfig({
      auth: {
        "claude-sdk": piProjection,
        anthropic: { ...piProjection, placeholder: "vendor-placeholder" },
      },
    })

    // The vendor's own row leads `piCredentialProviderIDs`, the same way the
    // engine's overlay precedence resolves the tie.
    expect(JSON.parse(await fs.readFile(path.join(f.agentDir, "models.json"), "utf8"))).toEqual({
      providers: { anthropic: { baseUrl: "http://127.0.0.1:2595/bindings/7c2d", apiKey: "vendor-placeholder" } },
    })
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

test("every provider the broker binds reaches Pi at Pi's own base path", async () => {
  const f = await installFakePiRpc()
  const adapter = new PiHarnessAdapter({
    binary: f.binary,
    agentDir: f.agentDir,
    store: createMemoryRuntimeStore(),
  })
  const binding = (apiPath: string) => ({ ...piProjection, apiPath })
  try {
    await adapter.applyConfig({ auth: {
      openrouter: binding("/api/v1"),
      google: binding("/v1beta"),
      groq: binding("/openai/v1"),
      xai: binding("/v1"),
    } })

    expect(JSON.parse(await fs.readFile(path.join(f.agentDir, "models.json"), "utf8"))).toEqual({
      providers: {
        // Pi 0.85.1's own base URLs: `openrouter` speaks the Anthropic wire
        // protocol under `/api` and appends `/v1/messages` itself, so the
        // binding's own API root would send it to `/api/v1/v1/messages`.
        openrouter: { baseUrl: "http://127.0.0.1:2595/bindings/7c2d/api", apiKey: "signed-placeholder" },
        google: { baseUrl: "http://127.0.0.1:2595/bindings/7c2d/v1beta", apiKey: "signed-placeholder" },
        groq: { baseUrl: "http://127.0.0.1:2595/bindings/7c2d/openai/v1", apiKey: "signed-placeholder" },
        xai: { baseUrl: "http://127.0.0.1:2595/bindings/7c2d/v1", apiKey: "signed-placeholder" },
      },
    })

    await adapter.createSession(f.agentDir)
    const launched = JSON.parse(await fs.readFile(path.join(f.agentDir, "launch-env.json"), "utf8"))
    for (const name of ["OPENROUTER_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "XAI_API_KEY"]) {
      expect(launched).not.toHaveProperty(name)
    }
  } finally {
    await adapter.dispose()
    await f.dispose()
  }
})

test("an unusable account refuses only the launches that would have spent it", async () => {
  const f = await installFakePiRpc()
  const adapter = new PiHarnessAdapter({
    binary: f.binary,
    agentDir: f.agentDir,
    store: createMemoryRuntimeStore(),
  })
  try {
    await adapter.applyConfig({ auth: {
      anthropic: { unavailable: true, reason: "auth_failed" },
      openai: piProjection,
    } })

    adapter.setModel("openai/gpt-5")
    await expect(adapter.createSession(f.agentDir, undefined, "on-openai")).resolves.toBeDefined()

    adapter.setModel("anthropic/claude-sonnet-4")
    await expect(adapter.createSession(f.agentDir, undefined, "on-anthropic"))
      .rejects.toThrow("the pi credential selected for this workspace cannot be used: auth_failed")
  } finally {
    await adapter.dispose()
    await f.dispose()
  }
})

test("PI_CODING_AGENT_DIR names the profile when nothing scopes one, and it is scrubbed on disposal", async () => {
  const f = await installFakePiRpc()
  const previous = process.env.PI_CODING_AGENT_DIR
  let adapter: PiHarnessAdapter
  try {
    process.env.PI_CODING_AGENT_DIR = f.agentDir
    adapter = new PiHarnessAdapter({
      binary: f.binary,
      store: createMemoryRuntimeStore(),
    })
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
  }
  const file = path.join(f.agentDir, "models.json")
  try {
    await adapter.applyConfig({ auth: {} })
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ providers: {} })
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
