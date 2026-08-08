import { afterEach, describe, expect, test } from "vitest"
import { realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

// Isolate config/data dir so the compat routes read a clean workspace store.
const root = path.join(realpathSync(os.tmpdir()), `opencode-compat-injected-${randomUUID().slice(0, 8)}`)
const prev = { CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR }
process.env.CLAXEDO_DATA_DIR = root

const { Hono } = await import("hono")
const { OpenCodeCompatRoutes } = await import("@claxedo/local-server/opencode/compat-routes/index")
const { __setOpenCodeEmbedLoaderForTests, configureOpenCodeEngine } = await import("@claxedo/server-core/opencode/engine")

afterEach(async () => {
  __setOpenCodeEmbedLoaderForTests(undefined)
  configureOpenCodeEngine({ embedded: true })
  await fs.rm(root, { recursive: true, force: true })
})

describe("opencode compat routes over a fake injected embedded transport", () => {
  test("proxies /provider through the embedded engine handler (no network)", async () => {
    // A fake embedded engine: the compat proxy must route to THIS handler, never
    // to a URL or the network.
    const calls: string[] = []
    __setOpenCodeEmbedLoaderForTests(async () => ({
      Server: {
        Default: () => ({
          app: {
            fetch: async (req: Request) => {
              const url = new URL(req.url)
              calls.push(`${req.method} ${url.pathname}`)
              if (url.pathname === "/provider") {
                return Response.json({
                  all: [
                    {
                      id: "opencode",
                      name: "OpenCode",
                      models: { big: { id: "big", name: "Big" } },
                    },
                  ],
                  default: { opencode: "opencode/big" },
                  connected: ["opencode"],
                })
              }
              return Response.json({}, { status: 404 })
            },
          },
        }),
      },
      InstanceRuntime: { disposeAllInstances: async () => {} },
    }) as never)
    configureOpenCodeEngine({ embedded: true })

    const app = new Hono()
    app.route("/", OpenCodeCompatRoutes({ env: {} }))

    const res = await app.request("/provider?runner=opencode")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { connected: string[] }
    expect(body.connected).toEqual(["opencode"])
    // Served from the injected in-process handler.
    expect(calls).toContain("GET /provider")
  })

  test("serves root /api/wr/events as the local compatibility event stream", async () => {
    const app = new Hono()
    app.route("/", OpenCodeCompatRoutes({ env: {} }))
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 50)

    const res = await app.request("/api/wr/events", { signal: ac.signal })

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
  })
})
