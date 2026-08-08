import { afterEach, describe, expect, test, vi } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"
import {
  __setOpenCodeEmbedLoaderForTests,
  configureOpenCodeApplicationTools,
  configureOpenCodeEmbedPath,
  configureOpenCodeEngine,
  drainOpenCodeEngine,
  opencodeEngineMode,
  OpenCodeEngineUnavailableError,
  opencodeRequest,
  OPENCODE_INTERNAL_BASE,
} from "./engine"
import { configureOpenCodeAuth } from "./auth"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  configureOpenCodeEmbedPath(undefined)
  __setOpenCodeEmbedLoaderForTests(undefined)
  configureOpenCodeApplicationTools(undefined)
  configureOpenCodeEngine({ embedded: true })
  configureOpenCodeAuth(null)
})

describe("opencode-engine URL mode", () => {
  test("rewrites the synthetic-base origin onto the configured URL and applies auth headers", async () => {
    configureOpenCodeAuth("hunter2")
    configureOpenCodeEngine({ url: "http://opencode.example:9999/base" })
    const seen: { url: string; method: string; auth: string | null; directory: string | null } = {
      url: "",
      method: "",
      auth: null,
      directory: null,
    }
    globalThis.fetch = (async (input: Request | string | URL) => {
      const req = input instanceof Request ? input : new Request(input)
      seen.url = req.url
      seen.method = req.method
      seen.auth = req.headers.get("authorization")
      seen.directory = req.headers.get("x-opencode-directory")
      return Response.json({ ok: true })
    }) as typeof fetch

    const res = await opencodeRequest(
      new Request(`${OPENCODE_INTERNAL_BASE}/session?foo=bar`, {
        headers: { "x-opencode-directory": "/repo" },
      }),
    )

    expect(res.status).toBe(200)
    // Origin rewritten onto configured URL; base path preserved; path+query kept.
    expect(seen.url).toBe("http://opencode.example:9999/base/session?foo=bar")
    expect(seen.method).toBe("GET")
    // opencodeHeaders applied the configured basic-auth password.
    expect(seen.auth).toBe(`Basic ${Buffer.from("opencode:hunter2").toString("base64")}`)
    // Routing header preserved through the rewrite.
    expect(seen.directory).toBe("/repo")
    expect(opencodeEngineMode()).toBe("external-url")
  })

  test("forwards a request body in URL mode (POST with duplex)", async () => {
    configureOpenCodeEngine({ url: "http://opencode.example" })
    let body = ""
    globalThis.fetch = (async (input: Request | string | URL) => {
      const req = input instanceof Request ? input : new Request(input)
      body = await req.text()
      return Response.json({ echoed: true })
    }) as typeof fetch

    const res = await opencodeRequest(
      new Request(`${OPENCODE_INTERNAL_BASE}/session`, {
        method: "POST",
        body: JSON.stringify({ title: "hi" }),
        duplex: "half",
      } as RequestInit),
    )

    expect(res.status).toBe(200)
    expect(JSON.parse(body)).toEqual({ title: "hi" })
  })
})

describe("opencode-engine embedded mode", () => {
  test("rejects with a structured, actionable error when the engine artifact fails to load", async () => {
    configureOpenCodeEngine({ embedded: true })
    expect(opencodeEngineMode()).toBe("embedded")
    const boom = new Error("Cannot find module 'opencode/node-embed'")
    __setOpenCodeEmbedLoaderForTests(async () => {
      throw boom
    })

    await expect(
      opencodeRequest(new Request(`${OPENCODE_INTERNAL_BASE}/session`)),
    ).rejects.toBeInstanceOf(OpenCodeEngineUnavailableError)

    // The error remains actionable for an installed app and carries a stable code.
    let caught: OpenCodeEngineUnavailableError | undefined
    try {
      await opencodeRequest(new Request(`${OPENCODE_INTERNAL_BASE}/session`))
    } catch (err) {
      caught = err as OpenCodeEngineUnavailableError
    }
    expect(caught?.code).toBe("opencode_engine_unavailable")
    expect(caught?.message).toContain("Reinstall or rebuild Claxedo")
  })

  test("serves requests through the injected embedded handler and drains only when loaded", async () => {
    const dispose = vi.fn(async () => {})
    const fetchHandler = vi.fn(async (req: Request) => Response.json({ path: new URL(req.url).pathname }))
    __setOpenCodeEmbedLoaderForTests(async () => ({
      Server: { Default: () => ({ app: { fetch: fetchHandler } }) },
      InstanceRuntime: { disposeAllInstances: dispose },
    }) as never)
    configureOpenCodeEngine({ embedded: true })

    const res = await opencodeRequest(new Request(`${OPENCODE_INTERNAL_BASE}/session`))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ path: "/session" })
    expect(fetchHandler).toHaveBeenCalledTimes(1)

    await drainOpenCodeEngine()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  test("registers process-owned tools before serving the first embedded request and disposes them on drain", async () => {
    const order: string[] = []
    const disposeTools = vi.fn(async () => { order.push("dispose-tools") })
    const disposeInstances = vi.fn(async () => { order.push("dispose-instances") })
    configureOpenCodeApplicationTools(async () => ({
      workgraph_create_stream: {
        description: "Create a Stream",
        inputSchema: { type: "object" },
        execute: async () => ({ ok: true }),
      },
    }))
    __setOpenCodeEmbedLoaderForTests(async () => ({
      ApplicationToolRuntime: {
        register: async (tools: Record<string, unknown>) => {
          order.push(`register:${Object.keys(tools).join(",")}`)
          return disposeTools
        },
      },
      Server: { Default: () => ({ app: { fetch: async () => {
        order.push("request")
        return Response.json({ ok: true })
      } } }) },
      InstanceRuntime: { disposeAllInstances: disposeInstances },
    }) as never)

    await opencodeRequest(new Request(`${OPENCODE_INTERNAL_BASE}/session`))
    expect(order).toEqual(["register:workgraph_create_stream", "request"])

    await drainOpenCodeEngine()
    expect(order).toEqual([
      "register:workgraph_create_stream",
      "request",
      "dispose-tools",
      "dispose-instances",
    ])
  })

  test("drain is a no-op when the engine was never loaded", async () => {
    // Fresh loader state (afterEach reset), engine never invoked.
    __setOpenCodeEmbedLoaderForTests(async () => {
      throw new Error("should not be called")
    })
    await expect(drainOpenCodeEngine()).resolves.toBeUndefined()
  })

  test("loads the embedded engine from a configured artifact path instead of bare-specifier resolution", async () => {
    // The desktop-bundled server cannot resolve the bare "opencode" specifier;
    // the composition root hands over an absolute artifact path.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-embed-"))
    const artifact = path.join(dir, "fake-engine.mjs")
    fs.writeFileSync(
      artifact,
      [
        `export const Server = { Default: () => ({ app: { fetch: async () => Response.json({ from: "configured-path" }) } }) }`,
        `export const InstanceRuntime = { disposeAllInstances: async () => {} }`,
      ].join("\n"),
    )
    configureOpenCodeEmbedPath(artifact)
    configureOpenCodeEngine({ embedded: true })

    const res = await opencodeRequest(new Request(`${OPENCODE_INTERNAL_BASE}/session`))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ from: "configured-path" })
    await drainOpenCodeEngine()
  })
})
