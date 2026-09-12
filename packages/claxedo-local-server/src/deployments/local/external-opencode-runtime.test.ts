import { afterEach, describe, expect, test, vi } from "vitest"
import { createServer, type Server } from "node:http"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createWorkspaceRuntimeApp,
  loopbackWorkspaceRuntimeExposure,
  WorkspaceRuntimeRoutes,
} from "@claxedo/workspace-runtime"
import { createOpenCodeServerConnectionProvider } from "@claxedo/opencode-server-adapter"

const roots: string[] = []
const servers: Server[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    ),
  )
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
    const reader = response.body?.getReader()
    if (!reader) {
      outgoing.end()
      return
    }
    const close = () => {
      void reader.cancel().catch(() => undefined)
    }
    outgoing.on("close", close)
    try {
      while (!outgoing.destroyed) {
        const chunk = await reader.read()
        if (chunk.done) break
        outgoing.write(chunk.value)
      }
      outgoing.end()
    } finally {
      outgoing.off("close", close)
      reader.releaseLock()
    }
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
  test.each(["root", "worktree"] as const)(
    "persists a first prompt through the %s mapping without leaking upstream identity",
    async (location) => {
      const root = await mkdtemp(join(tmpdir(), "claxedo-external-opencode-"))
      roots.push(root)
      const workspaceRoot = join(root, "workspace")
      let workspace = workspaceRoot
      await mkdir(workspaceRoot)
      vi.stubEnv("WORKSPACE_RUNTIME_WORKSPACES_DIR", join(root, "workspaces"))
      if (location === "worktree") {
        execFileSync("git", ["init", "--quiet"], { cwd: workspaceRoot })
        execFileSync(
          "git",
          [
            "-c",
            "user.name=Runtime test",
            "-c",
            "user.email=runtime@example.test",
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "Fixture",
          ],
          { cwd: workspaceRoot },
        )
      }
      const remoteWorkspace = location === "root" ? "/srv/team/project" : "/srv/team/worktree"
      const calls: Array<{ method: string; path: string; body?: unknown }> = []
      let events!: ReadableStreamDefaultController<Uint8Array>
      let remoteUserMessageId = ""
      let completed = false
      const baseUrl = await serve(async (request) => {
        const url = new URL(request.url)
        expect(request.headers.get("x-opencode-directory")).toBe(remoteWorkspace)
        const body = request.method === "POST" ? await request.json().catch(() => undefined) : undefined
        calls.push({ method: request.method, path: url.pathname, ...(body === undefined ? {} : { body }) })
        if (url.pathname === "/global/health") return Response.json({ healthy: true, version: "1.2.3" })
        if (url.pathname === "/session" && request.method === "POST") {
          return Response.json({ id: "ses_upstream", directory: remoteWorkspace, title: "External review" })
        }
        if (url.pathname === "/session/ses_upstream" && request.method === "DELETE") return Response.json(true)
        if (url.pathname === "/session/ses_upstream")
          return Response.json({ id: "ses_upstream", directory: remoteWorkspace })
        if (url.pathname === "/session/status")
          return Response.json(completed ? {} : { ses_upstream: { type: "busy" } })
        if (url.pathname === "/session/ses_upstream/message")
          return Response.json(
            completed
              ? [
                  {
                    info: {
                      id: "msg_remote_assistant",
                      sessionID: "ses_upstream",
                      role: "assistant",
                      parentID: remoteUserMessageId,
                      finish: "stop",
                      time: { completed: 1 },
                    },
                    parts: [
                      {
                        id: "part_remote",
                        messageID: "msg_remote_assistant",
                        sessionID: "ses_upstream",
                        type: "text",
                        text: "External first turn",
                      },
                    ],
                  },
                ]
              : [],
          )
        if (url.pathname === "/global/event")
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                events = controller
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify({ payload: { id: crypto.randomUUID(), type: "server.connected", properties: {} } })}\n\n`,
                  ),
                )
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          )
        if (url.pathname === "/session/ses_upstream/prompt_async") {
          remoteUserMessageId = (body as { messageID: string }).messageID
          completed = true
          events.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ directory: remoteWorkspace, payload: { id: crypto.randomUUID(), type: "session.idle", properties: { sessionID: "ses_upstream" } } })}\n\n`,
            ),
          )
          return new Response(null, { status: 204 })
        }
        return new Response("Not Found", { status: 404 })
      })
      const runtime = createWorkspaceRuntimeApp({
        target: { workspaceId: "ws_external", directory: workspaceRoot },
        storeRoot: join(root, "store"),
        connectionProviders: [createOpenCodeServerConnectionProvider()],
        exposure: loopbackWorkspaceRuntimeExposure(),
      })
      try {
        if (location === "worktree") {
          const created = await runtime.app.request(`http://runtime.test${WorkspaceRuntimeRoutes.worktrees}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: "claxedo_local" }),
          })
          expect(created.status, await created.clone().text()).toBe(201)
          const body = (await created.json()) as { worktree: { path: string; state: string } }
          expect(body.worktree.state).toBe("active")
          workspace = body.worktree.path
        }
        await runtime.host.apply({
          version: 4,
          mcp: {},
          auth: {},
          connections: [
            {
              connectionId: "external-opencode",
              providerKey: "opencode-server",
              configRevision: 1,
              enabled: true,
              config: {
                label: "Team OpenCode",
                baseUrl,
                workspacePaths: [
                  { sourceDirectory: workspaceRoot, targetDirectory: "/srv/team/project" },
                  ...(location === "worktree"
                    ? [{ sourceDirectory: workspace, targetDirectory: remoteWorkspace }]
                    : []),
                ],
              },
            },
          ],
          defaultHarness: { kind: "connection", connectionId: "external-opencode" },
        })

        const create = () =>
          runtime.app.request(
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

        const sent = await runtime.app.request(
          `http://runtime.test/session/claxedo_local/message?directory=${encodeURIComponent(workspace)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ parts: [{ type: "text", text: "hello" }] }),
          },
        )
        expect(sent.status, await sent.clone().text()).toBe(200)
        const messages = await runtime.app.request(
          `http://runtime.test/session/claxedo_local/message?directory=${encodeURIComponent(workspace)}`,
        )
        expect(messages.status).toBe(200)
        const history = (await messages.json()) as Array<{
          info: { id: string; sessionID: string; role: string }
          parts: Array<{ type: string; text?: string }>
        }>
        const assistant = history.find((message) => message.info.role === "assistant")
        expect(assistant?.info.sessionID).toBe("claxedo_local")
        expect(assistant?.info.id).not.toBe("msg_remote_assistant")
        expect(assistant?.parts).toEqual(
          expect.arrayContaining([expect.objectContaining({ type: "text", text: "External first turn" })]),
        )
        expect(history.find((message) => message.info.role === "user")?.parts).toEqual(
          expect.arrayContaining([expect.objectContaining({ type: "text", text: "hello" })]),
        )
        expect(calls.find((call) => call.path.endsWith("/prompt_async"))?.body).toMatchObject({
          parts: [{ type: "text", text: "hello" }],
        })

        const removed = await runtime.app.request(
          `http://runtime.test/session/claxedo_local?directory=${encodeURIComponent(workspace)}`,
          { method: "DELETE" },
        )
        expect(removed.status, await removed.clone().text()).toBe(200)
        expect(calls).toContainEqual({ method: "DELETE", path: "/session/ses_upstream" })
        expect(calls.some((call) => call.path.includes("claxedo_local"))).toBe(false)
      } finally {
        await runtime.dispose()
      }
    },
  )
})
