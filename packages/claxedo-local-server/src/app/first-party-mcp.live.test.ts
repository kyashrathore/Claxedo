import { afterAll, beforeAll, describe, expect, test } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { callTool, startLiveFirstPartyMcp, toolJson, toolText, type LiveMcpFixture } from "./test-support/first-party-mcp-live"

/**
 * The loopback mount over the whole composition it actually ships in: the real
 * local server, a session on the embedded `opencode` harness, the entry that
 * session's runtime injects, and an MCP client speaking streamable HTTP to it.
 *
 * `local-app.behaviour.test.ts` reaches the same route through `app.request()`
 * with a stubbed credential, which cannot tell whether the runtime the server
 * composed mints a bearer the server it is mounted in accepts — the two halves
 * are wired in different files and were only ever tested one at a time. Nor can
 * it tell whether the client the mount builds for that credential reaches the
 * runtime at all: it resolves paths against the local server's own fetch, and
 * the runtime proxy only dispatches a path it can resolve a workspace for.
 */

type RuntimeSession = { id: string; title?: string | null }
type RuntimeMessage = { info: { id: string; role: string }; parts: Array<{ type: string; text?: string }> }

let live: LiveMcpFixture
let sessionId: string

beforeAll(async () => {
  live = await startLiveFirstPartyMcp()
  sessionId = await live.createSession("first-party mcp")
}, 60_000)

afterAll(async () => {
  await live?.stop()
})

const initialize = (url: string, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
    }),
  })

describe("the first-party MCP a local session is launched with", () => {
  test("lists and opens a real repository document for its own runtime session", async () => {
    const file = path.join(live.workspace.directory, "mcp-document.md")
    const markdown = "# MCP document\n\nActual repository bytes 日本語\n"
    await fs.writeFile(file, markdown)
    const created = await fetch(`http://127.0.0.1:${live.port}/documents/from-repo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ directory: live.workspace.directory, workspace_id: live.workspace.id, path: "mcp-document.md", display_name: "MCP document" }),
    })
    expect(created.ok, await created.clone().text()).toBe(true)
    const document = await created.json() as { id: string }
    const client = await live.connect(sessionId)
    const listed = await callTool(client, "documents_list")
    const scoped = await callTool(client, "documents_list", { directory: live.workspace.directory })
    expect.soft(listed.isError, toolText(listed)).not.toBe(true)
    expect(scoped.isError, toolText(scoped)).not.toBe(true)
    expect((toolJson(listed) as { documents: Array<{ id: string }> }).documents.map((row) => row.id)).toContain(document.id)
    const other = await live.createSession("document grant must remain self-scoped")
    const opened = await callTool(client, "documents_open", { document: document.id, session: other })
    expect(opened.isError, toolText(opened)).not.toBe(true)
    const grant = toolJson(opened) as { document: string; session: string; path: string }
    expect(grant).toMatchObject({ document: document.id, session: sessionId })
    expect(path.isAbsolute(grant.path)).toBe(true)
    expect(await fs.readFile(grant.path, "utf8")).toBe(markdown)
    expect(await fs.realpath(grant.path)).toBe(await fs.realpath(file))
    for (const scope of [{ directory: path.dirname(live.workspace.directory) }, { project: "another-project" }]) {
      const denied = await callTool(client, "documents_list", scope)
      expect(denied.isError).toBe(true)
      expect(toolText(denied)).toContain("only in its own workspace directory")
    }
  })

  test("names the session in the URL the runtime injects, and serves the runtime audience over it", async () => {
    const entry = live.entryFor(sessionId)
    expect(entry.name).toBe("claxedo")
    expect(entry.url).toBe(`http://127.0.0.1:${live.port}/api/claxedo/mcp?session=${sessionId}`)

    const client = await live.connect(sessionId)
    expect(client.getServerVersion()).toMatchObject({ name: "claxedo" })

    // The runtime audience, in full: a model inside a session drives sessions,
    // subagents, processes and documents, answers only its own children's
    // questions, and never approves a permission, rejects a question, deletes
    // a session or touches workspace compute.
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      "create_subagent",
      "documents_list",
      "documents_open",
      "process_logs",
      "process_start",
      "process_stop",
      "processes",
      "question_reply",
      "session_abort",
      "session_create",
      "session_get",
      "session_send",
      "session_transcript",
      "sessions_list",
      "subagent_cancel",
      "subagent_capabilities",
      "subagent_list",
      "subagent_status",
    ])
  })

  test("reaches the runtime that injected it, so the tools answer about this workspace's own sessions", async () => {
    const client = await live.connect(sessionId)

    const board = (toolJson(
      await callTool(client, "sessions_list"),
    ) as { workspaces: Array<{ workspace: string; unavailable?: string; sessions?: RuntimeSession[] }> })
    expect(board.workspaces).toHaveLength(1)
    expect(board.workspaces[0]).toMatchObject({ workspace: live.workspace.id })
    expect(board.workspaces[0]?.unavailable).toBeUndefined()
    expect(board.workspaces[0]?.sessions?.map((row) => row.id)).toContain(sessionId)

    expect((toolJson(
      await callTool(client, "session_get", { session: sessionId }),
    ) as { session: { id: string; directory: string }; config: { harness: { id: string } } })).toMatchObject({
      session: { id: sessionId, directory: live.workspace.directory },
      config: { harness: { id: "opencode" } },
    })
  })

  test("admits a real turn through session_send and reads it back through session_transcript", async () => {
    const own = await live.createSession("turn round trip")
    const client = await live.connect(own)

    expect((toolJson(await callTool(client, "session_send", { session: own, text: "hello from the model" })) as { session: string; admitted: boolean }))
      .toEqual({ session: own, admitted: true })

    const page = (toolJson(await callTool(client, "session_transcript", { session: own })) as { messages: RuntimeMessage[] })
    const prompts = page.messages.filter((row) => row.info.role === "user").flatMap((row) => row.parts.map((part) => part.text ?? ""))
    expect(prompts).toContain("hello from the model")

    const stored = (await (await live.runtimeRequest(`/session/${own}/message`)).json()) as RuntimeMessage[]
    expect(page.messages.map((row) => row.info.id)).toEqual(stored.map((row) => row.info.id))
  })

  test("shows a session none of the approval tools and refuses one it calls anyway", async () => {
    const client = await live.connect(sessionId)
    const listed = (await client.listTools()).tools.map((tool) => tool.name)

    for (const tool of ["permission_reply", "question_reject", "session_delete", "workspace_lifecycle", "workspace_restore"]) {
      expect(listed, `${tool} is offered to a session's own credential`).not.toContain(tool)
      const refused = await callTool(client, tool, {})
      expect(refused.isError).toBe(true)
      expect(toolText(refused)).toContain(`Tool ${tool} not found`)
    }
  })

  test("refuses the same URL without the injected bearer", async () => {
    const refused = await initialize(live.entryFor(sessionId).url)
    expect(refused.status).toBe(401)
    expect(refused.headers.get("www-authenticate")).toBe('Bearer realm="claxedo-mcp"')
  })

  test("never takes the injected bearer from the URL", async () => {
    const entry = live.entryFor(sessionId)
    const token = entry.headers.Authorization?.replace(/^Bearer /, "")
    expect(token).toBeTruthy()
    expect((await initialize(`${entry.url}&access_token=${token}&token=${token}`)).status).toBe(401)
  })

  test("refuses a non-loopback Origin with 403 and sends no CORS header, even though the server answers CORS elsewhere", async () => {
    const entry = live.entryFor(sessionId)
    const refused = await initialize(entry.url, { ...entry.headers, origin: "https://evil.example" })
    expect(refused.status).toBe(403)
    expect(refused.headers.get("access-control-allow-origin")).toBeNull()
    // The server's own unsigned-local guard refuses ahead of the mount, so the
    // composed answer names that gate; the mount's own `mcp_loopback_only` is
    // the second gate and is pinned in `@claxedo/mcp`'s `server.test.ts`.
    expect(await refused.json()).toEqual({ error: { code: "unsigned_local_loopback_required", message: expect.any(String) } })

    const elsewhere = await fetch(`http://127.0.0.1:${live.port}/api/claxedo/workspace`, { headers: { origin: "https://evil.example" } })
    expect(elsewhere.headers.get("access-control-allow-origin")).toBe("https://evil.example")
  })
})
