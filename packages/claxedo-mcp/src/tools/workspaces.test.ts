import { afterEach, describe, expect, test } from "vitest"
import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { createClaxedoMcpClient } from "../client/index"
import type { ClaxedoFetch } from "../client/contract"
import { CLAXEDO_MCP_PATH, createClaxedoMcpRoutes, fullUserCredential } from "../server"
import { registerWorkspaceTools } from "./workspaces"
import { controlPlaneWorkspaceRow, workspaceListHostRows } from "../client/control-plane-workspaces.fixture"

type Call = { method: string; path: string; body?: Record<string, unknown> }

/**
 * The control plane's workspace routes as `workspace/routes/checkpoints.ts`
 * serves them, including the one behaviour these tools have to satisfy: a
 * restore, replace, cleanup or destroy without `approved: true` is refused 409.
 */
function controlPlane() {
  const calls: Call[] = []
  const fetchLike: ClaxedoFetch = async (path, init) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
    calls.push({ method: init?.method ?? "GET", path, ...(body ? { body } : {}) })
    const url = new URL(path, "http://control.local")
    const checkpoints = /^\/api\/workspace\/([^/]+)\/checkpoints$/.exec(url.pathname)
    if (checkpoints && init?.method !== "POST") {
      return Response.json({
        workspaceId: checkpoints[1],
        sandbox: { id: "sbx_1", status: "running" },
        epoch: 3,
        checkpoint: { id: "ckpt_9", createdAt: 1 },
        worktrees: [],
      })
    }
    if (checkpoints) return Response.json({ checkpoint: { id: "ckpt_10" }, policy: (body ?? {}).policy }, { status: 201 })

    const restore = /^\/api\/workspace\/([^/]+)\/checkpoints\/([^/]+)\/restore$/.exec(url.pathname)
    if (restore) {
      if (body?.approved !== true) return approvalRequired("Restore")
      return Response.json({ workspaceId: restore[1], restoredFrom: decodeURIComponent(restore[2]) })
    }

    const lifecycle = /^\/api\/workspace\/([^/]+)\/lifecycle\/([^/]+)$/.exec(url.pathname)
    if (lifecycle) {
      const operation = lifecycle[2]
      if (operation !== "stop" && body?.approved !== true) return approvalRequired(operation)
      return Response.json({ workspaceId: lifecycle[1], operation })
    }

    if (url.pathname === "/api/workspace") {
      const rows = [
        controlPlaneWorkspaceRow({ workspace_id: "ws_cloud", backing: "cloud-vm", display_name: "Cloud box", remote_directory: "/workspace" }),
        controlPlaneWorkspaceRow({ workspace_id: "ws_mac", backing: "local-worktree", display_name: "Mac", remote_directory: "/Users/me/app" }),
        controlPlaneWorkspaceRow({ workspace_id: "ws_old", backing: "local-worktree", host_online: false }),
      ]
      return Response.json({ workspaces: workspaceListHostRows(rows, url.searchParams.get("host")) })
    }
    return Response.json({ error: { code: "not_found", message: url.pathname } }, { status: 404 })
  }
  return { calls, fetch: fetchLike }
}

function approvalRequired(operation: string) {
  return Response.json(
    { error: { code: "workspace_lifecycle_approval_required", message: `${operation} requires explicit approval` } },
    { status: 409 },
  )
}

const servers: Array<ReturnType<typeof serve>> = []
const clients: Client[] = []
const mounts: Array<{ dispose(): void }> = []

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)))
  for (const mount of mounts.splice(0)) mount.dispose()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

async function listen() {
  const control = controlPlane()
  const routes = createClaxedoMcpRoutes({
    mount: "hosted",
    verifyRuntimeCredential: (token) =>
      token === "rt-token" ? { runtimeId: "rt_1", workspaceId: "ws_mac", expiresAt: Number.MAX_SAFE_INTEGER } : undefined,
    resolveUserCredential: async (request) =>
      request.headers.get("authorization") === "Bearer cli-jwt" ? fullUserCredential({ actorId: "actor_1", clientId: "cli" }) : undefined,
    createClient: () => createClaxedoMcpClient({ deployment: "hosted", controlPlane: { fetch: control.fetch } }),
    registerTools: [{ id: "workspaces", reach: "runtime", register: registerWorkspaceTools }],
    audit: () => undefined,
  })
  mounts.push(routes)
  const app = new Hono().route(CLAXEDO_MCP_PATH, routes.routes)
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" })
  servers.push(server)
  await new Promise<void>((resolve) => server.once("listening", () => resolve()))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no port")
  return { url: `http://127.0.0.1:${address.port}${CLAXEDO_MCP_PATH}`, control }
}

async function connect(url: string, token: string, elicit?: () => "accept" | "decline" | "cancel") {
  const client = new Client({ name: "fixture-host", version: "0.0.0" }, elicit ? { capabilities: { elicitation: { form: {} } } } : {})
  const prompts: string[] = []
  if (elicit) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      prompts.push(request.params.message)
      return { action: elicit(), content: {} }
    })
  }
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  clients.push(client)
  return { client, prompts }
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args })
  const [block] = result.content as Array<{ type: string; text: string }>
  return { text: block?.text ?? "", isError: result.isError === true }
}

const json = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const result = await call(client, name, args)
  if (result.isError) throw new Error(result.text)
  return JSON.parse(result.text) as Record<string, unknown>
}

describe("reading the account's workspaces", () => {
  test("lists provisioner-placed workspaces and machines, saying which machines are reachable", async () => {
    const { url } = await listen()
    const { client } = await connect(url, "cli-jwt")
    expect((await call(client, "workspaces_list")).text.split("\n")).toEqual([
      "ws_cloud (Cloud box) — cloud VM  /workspace",
      "ws_mac (Mac) — machine  online  /Users/me/app",
      "ws_old — machine  offline",
    ])
  })

  test("reports one workspace's sandbox, epoch and latest checkpoint", async () => {
    const { url, control } = await listen()
    const { client } = await connect(url, "cli-jwt")
    expect(await json(client, "workspace_status", { workspace: "ws_cloud" })).toMatchObject({
      sandbox: { id: "sbx_1", status: "running" },
      epoch: 3,
      checkpoint: { id: "ckpt_9" },
    })
    expect(control.calls).toEqual([{ method: "GET", path: "/api/workspace/ws_cloud/checkpoints" }])
  })
})

describe("changing a workspace's compute", () => {
  test("captures a checkpoint with the policy it was asked for", async () => {
    const { url, control } = await listen()
    const { client } = await connect(url, "cli-jwt")
    expect(await json(client, "workspace_checkpoint", { workspace: "ws_cloud", policy: "interrupt" })).toMatchObject({ checkpoint: { id: "ckpt_10" } })
    expect(control.calls).toEqual([{ method: "POST", path: "/api/workspace/ws_cloud/checkpoints", body: { policy: "interrupt" } }])
  })

  test("restores from the workspace's latest checkpoint when none is named", async () => {
    const { url, control } = await listen()
    const { client } = await connect(url, "cli-jwt", () => "accept")
    expect(await json(client, "workspace_restore", { workspace: "ws_cloud" })).toMatchObject({ restoredFrom: "ckpt_9" })
    expect(control.calls.map((row) => `${row.method} ${row.path}`)).toEqual([
      "GET /api/workspace/ws_cloud/checkpoints",
      "POST /api/workspace/ws_cloud/checkpoints/ckpt_9/restore",
    ])
    expect(control.calls[1].body).toEqual({ approved: true })
  })

  test("approves what the control plane refuses unapproved, and only for the operations that need it", async () => {
    const { url, control } = await listen()
    const { client } = await connect(url, "cli-jwt", () => "accept")
    expect(await json(client, "workspace_lifecycle", { workspace: "ws_cloud", operation: "destroy" })).toMatchObject({ operation: "destroy" })
    expect(await json(client, "workspace_lifecycle", { workspace: "ws_cloud", operation: "stop" })).toMatchObject({ operation: "stop" })
    expect(control.calls.map((row) => row.body)).toEqual([{ approved: true }, {}])
  })

  test("never takes approval from the model: no tool offers it as an argument", async () => {
    const { url, control } = await listen()
    const { client } = await connect(url, "cli-jwt", () => "accept")
    const tools = (await client.listTools()).tools
    expect(tools.map((tool) => tool.name).toSorted()).toEqual([
      "workspace_checkpoint",
      "workspace_lifecycle",
      "workspace_restore",
      "workspace_status",
      "workspaces_list",
    ])
    for (const tool of tools) {
      expect({ tool: tool.name, properties: Object.keys(tool.inputSchema.properties ?? {}) }).not.toMatchObject({ properties: expect.arrayContaining(["approved"]) })
    }
    // An approval the model invents is not an argument the tool has, so it
    // cannot reach the control plane whatever the model puts in the call.
    await json(client, "workspace_lifecycle", { workspace: "ws_cloud", operation: "cleanup", approved: false })
    expect(control.calls[0].body).toEqual({ approved: true })
  })

  test("stops before the control plane when the host declines the confirmation", async () => {
    const { url, control } = await listen()
    const declining = await connect(url, "cli-jwt", () => "decline")
    expect(await call(declining.client, "workspace_lifecycle", { workspace: "ws_cloud", operation: "destroy" })).toEqual({
      text: "workspace_lifecycle was not confirmed",
      isError: true,
    })
    expect(declining.prompts).toEqual(["Confirm workspace_lifecycle?"])
    expect(control.calls).toEqual([])
  })

  test("missing or cancelled confirmation never sends downstream approval or touches compute", async () => {
    const { url, control } = await listen()
    for (const elicit of [undefined, () => "cancel" as const]) {
      const { client } = await connect(url, "cli-jwt", elicit)
      expect(await call(client, "workspace_restore", { workspace: "ws_cloud" })).toMatchObject({ isError: true })
      for (const operation of ["stop", "replace", "cleanup", "destroy"]) {
        expect(await call(client, "workspace_lifecycle", { workspace: "ws_cloud", operation })).toMatchObject({ isError: true })
      }
    }
    expect(control.calls).toEqual([])
  })

  test("annotates the destructive tools without treating annotations as confirmation", async () => {
    const { url } = await listen()
    const { client } = await connect(url, "cli-jwt")
    const annotations = Object.fromEntries((await client.listTools()).tools.map((tool) => [tool.name, tool.annotations]))
    expect(annotations.workspace_lifecycle).toMatchObject({ destructiveHint: true, readOnlyHint: false })
    expect(annotations.workspace_restore).toMatchObject({ destructiveHint: true, readOnlyHint: false })
    expect(annotations.workspace_checkpoint).toMatchObject({ destructiveHint: false, readOnlyHint: false })
    expect(annotations.workspaces_list).toMatchObject({ destructiveHint: false, readOnlyHint: true })
  })
})

describe("a session's own credential", () => {
  test("is shown no workspace tool and cannot call one", async () => {
    const { url, control } = await listen()
    const { client } = await connect(url, "rt-token")
    expect((await client.listTools()).tools).toEqual([])
    await expect(client.callTool({ name: "workspace_lifecycle", arguments: { workspace: "ws_mac", operation: "destroy" } })).rejects.toThrow(
      /Method not found/,
    )
    expect(control.calls).toEqual([])
  })
})
