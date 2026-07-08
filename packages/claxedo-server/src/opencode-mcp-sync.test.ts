import { afterEach, describe, expect, test } from "vitest"
import { createServer, type Server } from "node:http"
import { once } from "node:events"
import {
  configureOpencodeMcpSync,
  mergeSyncedMcpStatus,
  syncMcpConfigToOpencode,
  syncOpencodeMcpConfig,
} from "./opencode-mcp-sync"
import type { OpenCodeRequestFn } from "@claxedo/agent-sdk-runtime/adapters"

const servers: Server[] = []

// The MCP sync now rides an injected transport rather than a URL. In these tests
// we forward the synthetic-base request onto the fake HTTP server via fetch.
function transportFor(url: string): OpenCodeRequestFn {
  return (req) => {
    const incoming = new URL(req.url)
    return fetch(`${url}${incoming.pathname}${incoming.search}`, {
      method: req.method,
      headers: req.headers,
      ...(["GET", "HEAD"].includes(req.method) ? {} : { body: req.body, duplex: "half" }),
    } as RequestInit)
  }
}

afterEach(async () => {
  configureOpencodeMcpSync({ enabled: false })
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

async function listen(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void) {
  const server = createServer(handler)
  servers.push(server)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port")
  return `http://127.0.0.1:${address.port}`
}

describe("opencode MCP sync", () => {
  test("pushes effective MCP config into the live opencode MCP endpoint", async () => {
    const requests: Array<{ url?: string; method?: string; directory?: string; body: unknown }> = []
    const url = await listen((req, res) => {
      const chunks: Buffer[] = []
      req.on("data", (chunk) => chunks.push(chunk))
      req.on("end", () => {
        requests.push({
          url: req.url,
          method: req.method,
          directory: req.headers["x-opencode-directory"]?.toString(),
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        })
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ docs: { status: "connected" } }))
      })
    })

    const results = await syncMcpConfigToOpencode(transportFor(url), {
      mcp: {
        docs: {
          type: "local",
          command: ["node", "/tmp/docs-mcp.js"],
          environment: { OPENCODE_API_URL: "http://127.0.0.1:3001" },
        },
      },
    }, { directory: "/repo" })

    expect(requests).toEqual([
      {
        url: "/mcp",
        method: "POST",
        directory: "/repo",
        body: {
          name: "docs",
          config: {
            type: "local",
            command: ["node", "/tmp/docs-mcp.js"],
            environment: { OPENCODE_API_URL: "http://127.0.0.1:3001" },
          },
        },
      },
    ])
    expect(results).toEqual([
      {
        name: "docs",
        ok: true,
        status: 200,
        body: { docs: { status: "connected" } },
      },
    ])
    expect(mergeSyncedMcpStatus({})).toEqual({ docs: { status: "connected" } })
  })

  // The ACP-runner short-circuit is enforced at the call site in
  // `agent-config.ts`, so this
  // function-level test no longer matches a real seam. The invariant
  // is now exercised by the agent-config integration tests.

  test("skips sync entirely when disabled, and no-ops on empty effective MCP when enabled", async () => {
    // Disabled: returns [] without touching the transport.
    configureOpencodeMcpSync({ enabled: false })
    expect(await syncOpencodeMcpConfig()).toEqual([])

    // Enabled but the effective MCP config is empty (no MCP servers configured
    // in this test env), so there is nothing to push — an empty result set.
    configureOpencodeMcpSync({ enabled: true })
    expect(await syncOpencodeMcpConfig()).toEqual([])
  })
})
