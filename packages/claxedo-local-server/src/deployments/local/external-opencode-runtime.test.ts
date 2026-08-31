import { afterEach, describe, expect, test } from "vitest"
import { createServer, type Server } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createWorkspaceRuntimeApp,
  loopbackWorkspaceRuntimeExposure,
} from "@claxedo/workspace-runtime"
import { createOpenCodeServerConnectionProvider } from "@claxedo/opencode-server-adapter"

const roots: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function serve(handler: (request: Request) => Response | Promise<Response>) {
  const server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = []
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("OpenCode fixture server has no TCP address")
    const request = new Request(`http://127.0.0.1:${address.port}${incoming.url}`, {
      method: incoming.method,
      headers: incoming.headers as HeadersInit,
      ...(chunks.length ? { body: Buffer.concat(chunks), duplex: "half" } : {}),
    } as RequestInit)
    const response = await handler(request)
    outgoing.writeHead(response.status, Object.fromEntries(response.headers))
    outgoing.end(Buffer.from(await response.arrayBuffer()))
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("OpenCode fixture server has no TCP address")
  return `http://127.0.0.1:${address.port}`
}

describe("external OpenCode through the embedded WorkspaceRuntime", () => {
  test("keeps Claxedo identity local while all provider calls use the remote session id", async () => {
    const root = await mkdtemp(join(tmpdir(), "claxedo-external-opencode-"))
    roots.push(root)
    const workspace = join(root, "workspace")
    const remoteWorkspace = "/srv/team/project"
    const calls: Array<{ method: string; path: string; body?: unknown }> = []
    const baseUrl = await serve(async (request) => {
      const url = new URL(request.url)
      const body = request.method === "POST" ? await request.json().catch(() => undefined) : undefined
      calls.push({ method: request.method, path: url.pathname, ...(body === undefined ? {} : { body }) })
      if (url.pathname === "/global/health") return Response.json({ healthy: true, version: "1.2.3" })
      if (url.pathname === "/session" && request.method === "POST") {
        return Response.json({ id: "ses_upstream", directory: remoteWorkspace, title: "External review" })
      }
      if (url.pathname === "/session/ses_upstream" && request.method === "DELETE") return Response.json(true)
      return new Response("Not Found", { status: 404 })
    })
    const runtime = createWorkspaceRuntimeApp({
      target: { workspaceId: "ws_external", directory: workspace },
      storeRoot: join(root, "store"),
      connectionProviders: [createOpenCodeServerConnectionProvider()],
      exposure: loopbackWorkspaceRuntimeExposure(),
    })
    await runtime.host.apply({
      version: 3,
      mcp: {},
      auth: {},
      connections: [{
        connectionId: "external-opencode",
        providerKey: "opencode-server",
        configRevision: 1,
        enabled: true,
        config: {
          label: "Team OpenCode",
          baseUrl,
          workspacePaths: [{ sourceDirectory: workspace, targetDirectory: remoteWorkspace }],
        },
      }],
      defaultHarness: { kind: "connection", connectionId: "external-opencode" },
    })

    const create = () => runtime.app.request(
      `http://runtime.test/session?directory=${encodeURIComponent(workspace)}&connectionId=external-opencode`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "claxedo_local", title: "External review" }),
      },
    )
    const first = await create()
    expect(first.status, await first.clone().text()).toBe(201)
    expect(await first.json()).toMatchObject({ id: "claxedo_local", directory: workspace })

    // A transport retry returns the already-bound local session instead of
    // creating a second provider conversation with a new OpenCode-generated id.
    expect((await create()).status).toBe(201)
    expect(calls.filter((call) => call.method === "POST" && call.path === "/session")).toHaveLength(1)
    expect(calls.find((call) => call.path === "/session")?.body).toEqual({ title: "External review" })

    const config = await runtime.app.request(
      `http://runtime.test/session/claxedo_local/config?directory=${encodeURIComponent(workspace)}`,
    )
    expect(config.status, await config.clone().text()).toBe(200)
    expect(await config.json()).toMatchObject({
      harness: { id: "external-opencode", access: "connection" },
    })

    const removed = await runtime.app.request(
      `http://runtime.test/session/claxedo_local?directory=${encodeURIComponent(workspace)}`,
      { method: "DELETE" },
    )
    expect(removed.status, await removed.clone().text()).toBe(200)
    expect(calls).toContainEqual({ method: "DELETE", path: "/session/ses_upstream" })
    expect(calls.some((call) => call.path.includes("claxedo_local"))).toBe(false)
    runtime.dispose()
  })
})
