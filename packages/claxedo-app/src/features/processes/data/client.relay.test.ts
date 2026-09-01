import { describe, expect, test } from "bun:test"
import { createProcessClient } from "./client"

const config = {
  id: "proc_1",
  name: "dev",
  command: "bun dev",
  args: [],
  autoStart: false,
  restartPolicy: "never",
  maxRestarts: 3,
}

const process = {
  configId: "proc_1",
  status: "running",
  restartCount: 0,
  ptyId: "pty_1",
}

function requestUrl(input: RequestInfo | URL) {
  if (input instanceof Request) return input.url
  if (input instanceof URL) return input.href
  return input
}

describe("process client relay transport", () => {
  test("routes cloud process config and lifecycle requests through Workspace Relay", async () => {
    const calls: Array<{ url: string; method: string; authorization: string | null }> = []
    const request = (async (input, init) => {
      const req = new Request(requestUrl(input), init)
      calls.push({
        url: req.url,
        method: req.method,
        authorization: req.headers.get("Authorization"),
      })

      if (req.url.startsWith("http://server.test/api/wr/process")) {
        throw new Error(`Unexpected claxedo-server process proxy request: ${req.method} ${req.url}`)
      }

      if (req.url === "http://server.test/api/workspace/ws_1/connection") {
        return Response.json({
          access: "cloud",
          backing: "cloud-vm",
          workspaceId: "ws_1",
          role: "admin",
          relayUrl: "https://relay.example.test",
          runtimeAccessToken: "rat_1",
          tokenExpiresAt: Date.now() + 120_000,
        })
      }

      if (req.url === "https://relay.example.test/workspaces/ws_1/api/wr/process") {
        if (req.method === "GET") return Response.json({ configs: [config], processes: [] })
        if (req.method === "POST") return Response.json(config, { status: 201 })
      }

      if (req.url === "https://relay.example.test/workspaces/ws_1/api/wr/process/proc_1") {
        if (req.method === "PUT") return Response.json(config)
        if (req.method === "DELETE") return Response.json(true)
      }

      if (req.url === "https://relay.example.test/workspaces/ws_1/api/wr/process/proc_1/start") {
        return Response.json({ kind: "started", process })
      }

      if (req.url === "https://relay.example.test/workspaces/ws_1/api/wr/process/proc_1/stop") {
        return Response.json(true)
      }

      throw new Error(`Unexpected request: ${req.method} ${req.url}`)
    }) as typeof fetch

    const client = createProcessClient({
      baseUrl: "http://server.test",
      directory: "/workspace",
      fetch: request,
      resolveWorkspaceRuntime: async () => ({
        kind: "cloud",
        workspaceId: "ws_1",
      }),
    })

    const previous = globalThis.fetch
    globalThis.fetch = request
    try {
      await client.list()
      await client.createConfig({ name: "dev", command: "bun dev" })
      await client.updateConfig("proc_1", { name: "dev", command: "bun dev" })
      await client.start("proc_1")
      await client.stop("proc_1")
      await client.deleteConfig("proc_1")
    } finally {
      globalThis.fetch = previous
    }

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET http://server.test/api/workspace/ws_1/connection",
      "GET https://relay.example.test/workspaces/ws_1/api/wr/process",
      "POST https://relay.example.test/workspaces/ws_1/api/wr/process",
      "PUT https://relay.example.test/workspaces/ws_1/api/wr/process/proc_1",
      "POST https://relay.example.test/workspaces/ws_1/api/wr/process/proc_1/start",
      "POST https://relay.example.test/workspaces/ws_1/api/wr/process/proc_1/stop",
      "DELETE https://relay.example.test/workspaces/ws_1/api/wr/process/proc_1",
    ])
    expect(calls.slice(1).every((call) => call.authorization === "Bearer rat_1")).toBe(true)
  })

  test("uses explicit workspace id for process requests without resolving the directory alias", async () => {
    const calls: string[] = []
    const request = (async (input, init) => {
      const req = new Request(requestUrl(input), init)
      calls.push(req.url)
      if (req.url.includes("/api/workspace/resolve")) {
        throw new Error(`unexpected workspace resolve: ${req.url}`)
      }
      if (req.url.startsWith("http://server.test/api/wr/process")) {
        throw new Error(`Unexpected direct process request: ${req.method} ${req.url}`)
      }
      if (req.url === "http://server.test/api/workspace/ws_direct/connection") {
        return Response.json({
          access: "cloud",
          backing: "cloud-vm",
          workspaceId: "ws_direct",
          role: "admin",
          relayUrl: "https://relay.example.test",
          runtimeAccessToken: "rat_direct",
          tokenExpiresAt: Date.now() + 120_000,
        })
      }
      if (req.url === "https://relay.example.test/workspaces/ws_direct/api/wr/process") {
        return Response.json({ configs: [config], processes: [] })
      }
      throw new Error(`Unexpected request: ${req.method} ${req.url}`)
    }) as typeof fetch

    const client = createProcessClient({
      baseUrl: "http://server.test",
      directory: "/workspace-alias",
      workspaceId: "ws_direct",
      fetch: request,
      resolveWorkspaceRuntime: async () => {
        throw new Error("expected explicit workspace id to skip runtime resolve")
      },
    })

    await client.list()

    expect(calls).toEqual([
      "http://server.test/api/workspace/ws_direct/connection",
      "https://relay.example.test/workspaces/ws_direct/api/wr/process",
    ])
  })

  // Regression: a signed user-hosted workspace addressed by its filesystem-path
  // directory has no `/api/workspace/resolve` entry on the hosted control
  // plane (that liveness read answers null for it), so a caller with only that
  // directory and no explicit workspaceId needs the synchronous signed
  // inventory match (`resolveSignedWorkspace`) to still reach the relay
  // instead of falling back to the plain central transport.
  test("uses the signed workspace inventory match when the runtime resolve read comes back empty", async () => {
    const calls: string[] = []
    const request = (async (input, init) => {
      const req = new Request(requestUrl(input), init)
      calls.push(req.url)
      if (req.url.startsWith("http://server.test/api/wr/process")) {
        throw new Error(`Unexpected central process request: ${req.method} ${req.url}`)
      }
      if (req.url === "http://server.test/api/workspace/ws_uh1/connection") {
        return Response.json({
          access: "user-hosted",
          backing: "local-worktree",
          workspaceId: "ws_uh1",
          role: "owner",
          relayUrl: "https://relay.example.test",
          runtimeAccessToken: "rat_uh1",
          tokenExpiresAt: Date.now() + 120_000,
        })
      }
      if (req.url === "https://relay.example.test/workspaces/ws_uh1/api/wr/process") {
        return Response.json({ configs: [config], processes: [] })
      }
      throw new Error(`Unexpected request: ${req.method} ${req.url}`)
    }) as typeof fetch

    const client = createProcessClient({
      baseUrl: "http://server.test",
      directory: "/repo/user-hosted/ws_uh1-dir",
      fetch: request,
      // The hosted control plane's liveness read for this directory answers
      // null — same as production for a user-hosted workspace it does not own.
      resolveWorkspaceRuntime: async () => null,
      resolveSignedWorkspace: (directory) =>
        directory === "/repo/user-hosted/ws_uh1-dir"
          ? { workspaceId: "ws_uh1", kind: "user-hosted", directory }
          : undefined,
    })

    await client.list()

    expect(calls).toEqual([
      "http://server.test/api/workspace/ws_uh1/connection",
      "https://relay.example.test/workspaces/ws_uh1/api/wr/process",
    ])
  })
})
