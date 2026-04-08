import { http, HttpResponse, passthrough, ws } from "msw"
import {
  loadFixtures,
  type DemoFixtures,
  type DemoMessage,
  type DemoPage,
  type DemoPreview,
  type DemoPty,
  type DemoSession,
} from "./fixtures"

const DEMO_BASE = window.location.origin
const ptyWs = ws.link(/wss?:\/\/[^/]+\/api\/claxedo\/pty\/([^/]+)\/connect/)
const MOCK_SESSION_TEXT = "you are seeing a fake mocked message"
const MOCK_TUI_TEXT = "you are seeing a mocked response"

const ESC = "\x1b"
const CSI = `${ESC}[`
const NL = "\r\n"

type State = DemoFixtures & {
  ptyHistory: Record<string, string>
  ptyLine: Map<string, string>
  tabContext: Record<string, Record<string, unknown>>
}

const bold = (value: string) => `${CSI}1m${value}${CSI}0m`
const green = (value: string) => `${CSI}32m${value}${CSI}0m`
const cyan = (value: string) => `${CSI}36m${value}${CSI}0m`
const yellow = (value: string) => `${CSI}33m${value}${CSI}0m`
const dim = (value: string) => `${CSI}2m${value}${CSI}0m`
const magenta = (value: string) => `${CSI}35m${value}${CSI}0m`

const prompt = () => `${green(bold("demo"))}${dim(":")}${cyan(bold("~/projects/my-app"))} ${dim("$")} `

function boot(kind: "claude" | "codex") {
  if (kind === "claude") {
    return [
      `${prompt()}claude --dangerously-skip-permissions`,
      "",
      `${magenta("●")} ${bold("Claude")} ready`,
      dim("Type a prompt to simulate an assistant reply."),
      "",
      `${prompt()}`,
    ].join(NL)
  }

  return [
    `${prompt()}codex --full-auto`,
    "",
    `${yellow("●")} ${bold("Codex")} ready`,
    dim("Type a prompt to simulate a mocked terminal response."),
    "",
    `${prompt()}`,
  ].join(NL)
}

function reply(kind: "claude" | "codex", input: string) {
  const name = kind === "claude" ? "Claude" : "Codex"
  return [
    "",
    `${magenta("●")} ${bold(name)} mock reply`,
    dim(`Prompt: ${input}`),
    MOCK_TUI_TEXT,
    "",
    `${prompt()}`,
  ].join(NL)
}

function kindOf(value: { title?: string; command?: string } | undefined) {
  const text = `${value?.title ?? ""} ${value?.command ?? ""}`.toLowerCase()
  if (text.includes("claude")) return "claude" as const
  if (text.includes("codex")) return "codex" as const
  return "shell" as const
}

function startOf(kind: "claude" | "codex" | "shell") {
  if (kind === "claude") return "claude --dangerously-skip-permissions"
  if (kind === "codex") return "codex --full-auto"
  return ""
}

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
}

function textOf(parts: unknown) {
  if (!Array.isArray(parts)) return ""
  return parts
    .flatMap((item) => {
      if (!item || typeof item !== "object") return []
      if (!("type" in item) || item.type !== "text") return []
      if (!("text" in item) || typeof item.text !== "string") return []
      return [item.text]
    })
    .join("\n")
    .trim()
}

function part(sessionID: string, messageID: string, id: string, text: string) {
  return { id, sessionID, messageID, type: "text", text }
}

function row(input: {
  sessionID: string
  directory: string
  messageID: string
  parentID: string
  agent: string
  providerID: string
  modelID: string
  text: string
}) {
  return {
    info: {
      id: input.messageID,
      sessionID: input.sessionID,
      role: "assistant" as const,
      time: { created: Date.now(), completed: Date.now() },
      parentID: input.parentID,
      modelID: input.modelID,
      providerID: input.providerID,
      agent: input.agent,
      mode: "code",
      path: { cwd: input.directory, root: input.directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [part(input.sessionID, input.messageID, `${input.messageID}_text`, input.text)],
  } satisfies DemoMessage
}

function user(input: {
  sessionID: string
  messageID: string
  agent: string
  providerID: string
  modelID: string
  text: string
  system?: string
  variant?: string
}) {
  return {
    info: {
      id: input.messageID,
      sessionID: input.sessionID,
      role: "user" as const,
      time: { created: Date.now() },
      agent: input.agent,
      model: { providerID: input.providerID, modelID: input.modelID },
      ...(input.system ? { system: input.system } : {}),
      ...(input.variant ? { variant: input.variant } : {}),
    },
    parts: [part(input.sessionID, input.messageID, `${input.messageID}_text`, input.text)],
  } satisfies DemoMessage
}

function projectFor(state: State, dir: string) {
  return state.projects.find((item) => item.worktree === dir || item.sandboxes?.includes(dir))
}

function projectInfo(state: State, dir: string) {
  return state.projectInfo[dir] ?? {
    id: projectFor(state, dir)?.id ?? dir,
    name: dir.split("/").at(-1) ?? dir,
    worktree: dir,
  }
}

function pageID() {
  return `page_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

function stateOf(data: DemoFixtures): State {
  const ptyHistory = Object.fromEntries(
    data.ptys.map((pty) => {
      const kind = kindOf(pty)
      return [pty.id, kind === "shell" ? `${prompt()}` : boot(kind)]
    }),
  )

  return {
    ...data,
    ptyHistory,
    ptyLine: new Map(),
    tabContext: {},
  }
}

function ensurePty(state: State, id: string) {
  const pty = state.ptys.find((item) => item.id === id)
  const kind = kindOf(pty)
  if (!state.ptyHistory[id]) {
    state.ptyHistory[id] = kind === "shell" ? `${prompt()}` : boot(kind)
  }
  if (!state.ptyPreview[id] && pty && kind !== "shell") {
    state.ptyPreview[id] = {
      terminalId: id,
      workspaceId: pty.cwd,
      provider: kind,
      sessionId: null,
      refName: `mocked-${kind}-terminal`,
      prompt: "type anything in the terminal",
      lastAssistantMessage: MOCK_TUI_TEXT,
      eventType: "assistant.completed",
      updatedAt: Date.now(),
    }
  }
  return { pty, kind }
}

function sessionFor(state: State, id: string) {
  return state.sessions.find((item) => item.id === id)
}

function pageFor(state: State, id: string) {
  return state.pages.find((item) => item.id === id)
}

function heartbeat(data: Record<string, unknown>) {
  return new ReadableStream({
    start(ctrl) {
      const enc = new TextEncoder()
      ctrl.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`))
      setInterval(() => {
        try {
          ctrl.enqueue(enc.encode(": heartbeat\n\n"))
        } catch {}
      }, 10_000)
    },
  })
}

function sse(stream: ReadableStream) {
  return new HttpResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  })
}

function preview(state: State, id: string, next: Partial<DemoPreview>) {
  const old = state.ptyPreview[id]
  state.ptyPreview[id] = {
    ...(old ?? {
      terminalId: id,
      sessionId: null,
      refName: `mocked-${next.provider ?? "shell"}-terminal`,
    }),
    ...next,
    updatedAt: Date.now(),
  }
}

export async function createHandlers() {
  const state = stateOf(await loadFixtures())
  const root = state.projects[0]?.worktree ?? "/home/demo/projects/my-app"

  const ptyWsHandler = ptyWs.addEventListener("connection", ({ client, params }) => {
    const id = (params as Record<string, string>)["0"] ?? ""
    const { kind, pty } = ensurePty(state, id)
    const output = state.ptyHistory[id] || `${prompt()}`

    const send = () => {
      if (output) client.send(output)
      try {
        const meta = JSON.stringify({ cursor: output.length })
        const bytes = new TextEncoder().encode(meta)
        const frame = new Uint8Array(1 + bytes.length)
        frame[0] = 0x00
        frame.set(bytes, 1)
        client.send(frame.buffer)
      } catch {}
    }

    setTimeout(send, 50)

    client.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return
      const startup = startOf(kind)
      if (startup && event.data.trim() === startup) return
      client.send(event.data)
      state.ptyHistory[id] = (state.ptyHistory[id] ?? output) + event.data
      if (kind === "shell") return
      const next = `${state.ptyLine.get(id) ?? ""}${event.data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")}`
      const lines = next.split(/\r\n|\n|\r/g)
      state.ptyLine.set(id, lines.pop() ?? "")
      const line = lines.map((item) => item.trim()).findLast(Boolean)
      if (!line) return
      const block = reply(kind, line)
      state.ptyHistory[id] += block
      preview(state, id, {
        workspaceId: pty?.cwd ?? root,
        provider: kind,
        prompt: line,
        lastAssistantMessage: MOCK_TUI_TEXT,
        eventType: "assistant.completed",
      })
      setTimeout(() => {
        try {
          client.send(block)
        } catch {}
      }, 180)
    })
  })

  return [
    ptyWsHandler,
    http.get(`${DEMO_BASE}/global/health`, () => {
      return HttpResponse.json({ healthy: true, version: "0.1.0-demo" })
    }),
    http.get(`${DEMO_BASE}/global/event`, () => {
      return sse(
        heartbeat({
          directory: "global",
          payload: { type: "server.connected", properties: {} },
        }),
      )
    }),
    http.get(`${DEMO_BASE}/global/config`, () => {
      return HttpResponse.json(state.globalConfig)
    }),
    http.get(`${DEMO_BASE}/provider`, () => {
      return HttpResponse.json(state.provider)
    }),
    http.get(`${DEMO_BASE}/provider/auth`, () => {
      return HttpResponse.json(state.providerAuth)
    }),
    http.get(`${DEMO_BASE}/agent`, () => {
      return HttpResponse.json(state.agents)
    }),
    http.get(`${DEMO_BASE}/config`, () => {
      return HttpResponse.json(state.config)
    }),
    http.patch(`${DEMO_BASE}/config`, async ({ request }) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
      Object.assign(state.config, body)
      return HttpResponse.json(state.config)
    }),
    http.get(`${DEMO_BASE}/project`, () => {
      return HttpResponse.json(state.projects)
    }),
    http.get(`${DEMO_BASE}/project/current`, ({ request }) => {
      const dir =
        new URL(request.url).searchParams.get("directory")
        || request.headers.get("x-opencode-directory")
        || root
      return HttpResponse.json(projectFor(state, dir) ?? state.projects[0] ?? null)
    }),
    http.get(`${DEMO_BASE}/session`, () => {
      return HttpResponse.json(state.sessions)
    }),
    http.get(`${DEMO_BASE}/session/status`, () => {
      return HttpResponse.json({})
    }),
    http.get(`${DEMO_BASE}/session/diff-targets`, () => {
      return HttpResponse.json(state.sessionDiffTargets)
    }),
    http.get(`${DEMO_BASE}/session/:sessionID/diff`, ({ params }) => {
      return HttpResponse.json(state.sessionDiffs[params.sessionID as string] ?? [])
    }),
    http.get(`${DEMO_BASE}/experimental/session`, () => {
      return HttpResponse.json(
        state.sessions.map((item) => ({
          ...item,
          project: projectInfo(state, item.directory),
        })),
      )
    }),
    http.post(`${DEMO_BASE}/session`, async ({ request }) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
      const id = `ses_demo_${Math.random().toString(36).slice(2, 8)}`
      const dir = typeof body.directory === "string" && body.directory ? body.directory : root
      const project = projectFor(state, dir)
      const session: DemoSession = {
        id,
        slug: id,
        projectID: project?.id ?? state.projects[0]?.id ?? "proj_demo_001",
        directory: dir,
        title: "",
        version: "2",
        time: { created: Date.now(), updated: Date.now() },
        summary: { additions: 0, deletions: 0, files: 0 },
      }
      Object.assign(session, body)
      state.sessions.unshift(session)
      state.sessionMessages[id] = []
      return HttpResponse.json(session)
    }),
    http.get(`${DEMO_BASE}/session/:id`, ({ params }) => {
      const session = sessionFor(state, params.id as string)
      if (!session) {
        return HttpResponse.json({ name: "NotFoundError", message: "Session not found" }, { status: 404 })
      }
      return HttpResponse.json(session)
    }),
    http.get(`${DEMO_BASE}/session/:id/children`, () => {
      return HttpResponse.json([])
    }),
    http.get(`${DEMO_BASE}/session/:id/message`, ({ params }) => {
      return HttpResponse.json(state.sessionMessages[params.id as string] ?? [])
    }),
    http.get(`${DEMO_BASE}/session/:id/event`, () => {
      return sse(heartbeat({ payload: { type: "server.connected", properties: {} } }))
    }),
    http.post(`${DEMO_BASE}/session/:id/chat`, () => {
      return HttpResponse.json({ ok: true })
    }),
    http.post(`${DEMO_BASE}/session/:id/message`, async ({ params, request }) => {
      const sessionID = params.id as string
      const session = sessionFor(state, sessionID)
      if (!session) {
        return HttpResponse.json({ name: "NotFoundError", message: "Session not found" }, { status: 404 })
      }
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
      const model =
        body.model && typeof body.model === "object"
          ? (body.model as { providerID?: string; modelID?: string })
          : {}
      const providerID = model.providerID || "anthropic"
      const modelID = model.modelID || (providerID === "openai" ? "codex-1" : "claude-sonnet-4-20250514")
      const agent = typeof body.agent === "string" && body.agent ? body.agent : "code"
      const text = textOf(body.parts) || "mock prompt"
      const messageID =
        typeof body.messageID === "string" && body.messageID ? body.messageID : `msg_${Date.now()}_user`
      const assistantID = `msg_${Date.now()}_assistant`
      const items = state.sessionMessages[sessionID] ?? []
      const nextUser = user({
        sessionID,
        messageID,
        agent,
        providerID,
        modelID,
        text,
        system: typeof body.system === "string" ? body.system : undefined,
        variant: typeof body.variant === "string" ? body.variant : undefined,
      })
      const nextAssistant = row({
        sessionID,
        directory: session.directory,
        messageID: assistantID,
        parentID: messageID,
        agent,
        providerID,
        modelID,
        text: MOCK_SESSION_TEXT,
      })
      state.sessionMessages[sessionID] = [...items, nextUser, nextAssistant]
      session.title = session.title || slug(text) || session.title
      session.time.updated = Date.now()
      return HttpResponse.json(nextAssistant)
    }),
    http.post(`${DEMO_BASE}/session/:id/prompt_async`, async ({ params, request }) => {
      const sessionID = params.id as string
      const session = sessionFor(state, sessionID)
      if (!session) return new HttpResponse(null, { status: 404 })
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
      const model =
        body.model && typeof body.model === "object"
          ? (body.model as { providerID?: string; modelID?: string })
          : {}
      const providerID = model.providerID || "anthropic"
      const modelID = model.modelID || (providerID === "openai" ? "codex-1" : "claude-sonnet-4-20250514")
      const agent = typeof body.agent === "string" && body.agent ? body.agent : "code"
      const text = textOf(body.parts) || "mock prompt"
      const messageID =
        typeof body.messageID === "string" && body.messageID ? body.messageID : `msg_${Date.now()}_user`
      const assistantID = `msg_${Date.now()}_assistant`
      const items = state.sessionMessages[sessionID] ?? []
      state.sessionMessages[sessionID] = [
        ...items,
        user({
          sessionID,
          messageID,
          agent,
          providerID,
          modelID,
          text,
          system: typeof body.system === "string" ? body.system : undefined,
          variant: typeof body.variant === "string" ? body.variant : undefined,
        }),
        row({
          sessionID,
          directory: session.directory,
          messageID: assistantID,
          parentID: messageID,
          agent,
          providerID,
          modelID,
          text: MOCK_SESSION_TEXT,
        }),
      ]
      session.title = session.title || slug(text) || session.title
      session.time.updated = Date.now()
      return new HttpResponse(null, { status: 204 })
    }),
    http.patch(`${DEMO_BASE}/session/:id`, async ({ params, request }) => {
      const session = sessionFor(state, params.id as string)
      if (!session) return HttpResponse.json(null, { status: 404 })
      Object.assign(session, (await request.json().catch(() => ({}))) as Record<string, unknown>)
      return HttpResponse.json(session)
    }),
    http.delete(`${DEMO_BASE}/session/:id`, ({ params }) => {
      const id = params.id as string
      const index = state.sessions.findIndex((item) => item.id === id)
      if (index >= 0) state.sessions.splice(index, 1)
      delete state.sessionMessages[id]
      return HttpResponse.json(true)
    }),
    http.get(`${DEMO_BASE}/session/:id/todo`, () => {
      return HttpResponse.json([])
    }),
    http.get(`${DEMO_BASE}/api/claxedo/pty`, () => {
      return HttpResponse.json(state.ptys)
    }),
    http.get(`${DEMO_BASE}/api/claxedo/pty/:id`, ({ params }) => {
      const pty = state.ptys.find((item) => item.id === params.id)
      if (!pty) return HttpResponse.json(null, { status: 404 })
      return HttpResponse.json(pty)
    }),
    http.post(`${DEMO_BASE}/api/claxedo/pty`, async ({ request }) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
      const id = `pty_demo_${Math.random().toString(36).slice(2, 8)}`
      const pty: DemoPty = {
        id,
        title: (body.title as string) || "shell",
        command: (body.command as string) || "/bin/zsh",
        args: (body.args as string[]) || [],
        cwd: (body.cwd as string) || root,
        status: "running",
        pid: 10000 + Math.floor(Math.random() * 50000),
      }
      state.ptys.push(pty)
      const kind = kindOf(pty)
      if (kind === "shell") {
        state.ptyHistory[id] = `${prompt()}`
      } else {
        state.ptyHistory[id] = boot(kind)
        preview(state, id, {
          workspaceId: pty.cwd,
          provider: kind,
          prompt: "type anything in the terminal",
          lastAssistantMessage: MOCK_TUI_TEXT,
          eventType: "assistant.completed",
        })
      }
      return HttpResponse.json(pty)
    }),
    http.patch(`${DEMO_BASE}/api/claxedo/pty/:id`, async ({ params, request }) => {
      const pty = state.ptys.find((item) => item.id === params.id)
      if (!pty) return HttpResponse.json(null, { status: 404 })
      Object.assign(pty, (await request.json().catch(() => ({}))) as Record<string, unknown>)
      return HttpResponse.json(pty)
    }),
    http.delete(`${DEMO_BASE}/api/claxedo/pty/:id`, ({ params }) => {
      const id = params.id as string
      const index = state.ptys.findIndex((item) => item.id === id)
      if (index >= 0) state.ptys.splice(index, 1)
      delete state.ptyHistory[id]
      delete state.ptyPreview[id]
      state.ptyLine.delete(id)
      return HttpResponse.json(true)
    }),
    http.get(`${DEMO_BASE}/find/file`, () => {
      return HttpResponse.json(state.fileSearch)
    }),
    http.get(`${DEMO_BASE}/file`, ({ request }) => {
      const path = new URL(request.url).searchParams.get("path") ?? ""
      return HttpResponse.json(state.fileTree[path] ?? [])
    }),
    http.get(`${DEMO_BASE}/file/content`, () => {
      return HttpResponse.json(state.fileContent)
    }),
    http.get(`${DEMO_BASE}/file/status`, () => {
      return HttpResponse.json(state.fileStatus)
    }),
    http.get(`${DEMO_BASE}/api/claxedo/hook/terminal-session`, ({ request }) => {
      const id = new URL(request.url).searchParams.get("terminalId")?.trim()
      if (!id) {
        return HttpResponse.json({ success: false, error: "terminalId is required" }, { status: 400 })
      }
      const session = state.ptyPreview[id]
      if (!session) {
        return HttpResponse.json({ success: false, error: "No terminal session found" }, { status: 404 })
      }
      return HttpResponse.json({
        success: true,
        source: "demo",
        terminalId: id,
        session,
      })
    }),
    http.get(`${DEMO_BASE}/api/claxedo/hook/tab-context`, ({ request }) => {
      const id = new URL(request.url).searchParams.get("tabId")?.trim()
      return HttpResponse.json({
        success: true,
        source: "demo",
        context: (id && state.tabContext[id]) || undefined,
      })
    }),
    http.post(`${DEMO_BASE}/api/claxedo/hook/tab-context`, async ({ request }) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
      const id = typeof body.tabId === "string" ? body.tabId : ""
      if (id) state.tabContext[id] = body
      return HttpResponse.json({ success: true, source: "demo", context: id ? state.tabContext[id] : undefined })
    }),
    http.get(`${DEMO_BASE}/api/claxedo/hook/setup/status`, () => {
      return HttpResponse.json({ ready: true, wrappers: ["claude", "codex"], customWrappers: [] })
    }),
    http.post(`${DEMO_BASE}/api/claxedo/hook/setup`, () => {
      return HttpResponse.json({ success: true })
    }),
    http.post(`${DEMO_BASE}/api/claxedo/hook/agent-lifecycle`, () => {
      return HttpResponse.json({ success: true })
    }),
    http.get(`${DEMO_BASE}/api/claxedo/hook/mcp-agents`, () => {
      return HttpResponse.json({
        servers: {
          "claxedo-mcp": { opencode: true, claude: true, gemini: true, cursor: true },
        },
        managed: ["claxedo-mcp"],
        capable: ["opencode", "claude", "gemini", "cursor"],
      })
    }),
    http.post(`${DEMO_BASE}/api/claxedo/hook/mcp-agents`, async ({ request }) => {
      const body = (await request.json()) as { server: string; agent: string; enabled: boolean }
      return HttpResponse.json({ success: true, server: body.server, agent: body.agent, enabled: body.enabled })
    }),
    http.get(`${DEMO_BASE}/mcp`, () => {
      return HttpResponse.json(state.mcp)
    }),
    http.get(`${DEMO_BASE}/permission`, () => {
      return HttpResponse.json(state.permissions)
    }),
    http.get(`${DEMO_BASE}/question`, () => {
      return HttpResponse.json(state.questions)
    }),
    http.get(`${DEMO_BASE}/path`, ({ request }) => {
      const dir =
        new URL(request.url).searchParams.get("directory")
        ?? request.headers.get("x-opencode-directory")
        ?? root
      return HttpResponse.json({
        ...state.path,
        worktree: dir,
        directory: dir,
      })
    }),
    http.get(`${DEMO_BASE}/skill`, () => {
      return HttpResponse.json(state.skills)
    }),
    http.get(`${DEMO_BASE}/command`, () => {
      return HttpResponse.json(state.commands)
    }),
    http.post(`${DEMO_BASE}/log`, () => {
      return HttpResponse.json(true)
    }),
    http.get(`${DEMO_BASE}/vcs`, () => {
      return HttpResponse.json(state.vcs)
    }),
    http.get(`${DEMO_BASE}/lsp`, () => {
      return HttpResponse.json([])
    }),
    http.get(`${DEMO_BASE}/event`, () => {
      return sse(
        heartbeat({
          directory: root,
          payload: { type: "server.connected", properties: {} },
        }),
      )
    }),
    http.get(`${DEMO_BASE}/api/claxedo/events`, () => {
      return sse(
        new ReadableStream({
          start(ctrl) {
            const enc = new TextEncoder()
            const send = (event: Record<string, unknown>) =>
              ctrl.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`))
            send({ type: "heartbeat" })
            setInterval(() => {
              try {
                send({ type: "heartbeat" })
              } catch {}
            }, 30_000)
          },
        }),
      )
    }),
    http.get(`${DEMO_BASE}/pages/statuses`, () => {
      return HttpResponse.json([])
    }),
    http.put(`${DEMO_BASE}/pages/statuses`, async ({ request }) => {
      const body = (await request.json().catch(() => [])) as unknown[]
      return HttpResponse.json(body)
    }),
    http.get(`${DEMO_BASE}/pages/by-file`, () => {
      return HttpResponse.json(null)
    }),
    http.get(`${DEMO_BASE}/pages`, () => {
      return HttpResponse.json(state.pages)
    }),
    http.post(`${DEMO_BASE}/pages`, async ({ request }) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
      const page: DemoPage = {
        id: pageID(),
        title: (body.title as string) || "Untitled",
        content: (body.content as string) || "",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      state.pages.unshift(page)
      return HttpResponse.json(page, { status: 201 })
    }),
    http.get(`${DEMO_BASE}/pages/:id`, ({ params }) => {
      const page = pageFor(state, params.id as string)
      if (!page) return HttpResponse.json({ error: "Not found" }, { status: 404 })
      return HttpResponse.json(page)
    }),
    http.patch(`${DEMO_BASE}/pages/:id`, async ({ params, request }) => {
      const page = pageFor(state, params.id as string)
      if (!page) return HttpResponse.json({ error: "Not found" }, { status: 404 })
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
      if (body.title !== undefined) page.title = body.title as string
      if (body.content !== undefined) page.content = body.content as string
      page.updated_at = new Date().toISOString()
      return HttpResponse.json(page)
    }),
    http.delete(`${DEMO_BASE}/pages/:id`, ({ params }) => {
      const index = state.pages.findIndex((item) => item.id === params.id)
      if (index < 0) return HttpResponse.json({ error: "Not found" }, { status: 404 })
      state.pages.splice(index, 1)
      return HttpResponse.json({ ok: true })
    }),
    http.patch(`${DEMO_BASE}/pages/:id/session`, ({ params }) => {
      const page = pageFor(state, params.id as string)
      if (!page) return HttpResponse.json({ error: "Not found" }, { status: 404 })
      return HttpResponse.json(page)
    }),
    http.post(`${DEMO_BASE}/pages/:id/status`, ({ params }) => {
      const page = pageFor(state, params.id as string)
      if (!page) return HttpResponse.json({ error: "Not found" }, { status: 404 })
      return HttpResponse.json(page)
    }),
    http.get(`${DEMO_BASE}/pages/:id/arena/state`, () => {
      return HttpResponse.json(state.arenaState)
    }),
    http.post(`${DEMO_BASE}/pages/:id/arena/start`, () => {
      return HttpResponse.json(state.arenaState)
    }),
    http.post(`${DEMO_BASE}/pages/:id/arena/message`, () => {
      return HttpResponse.json({ ok: true, wave_id: "wave_demo", state: state.arenaState })
    }),
    http.post(`${DEMO_BASE}/pages/:id/arena/control`, () => {
      return HttpResponse.json({ ok: true, state: state.arenaState })
    }),
    http.get(`${DEMO_BASE}/pages/:id/arena/events`, () => {
      return sse(
        heartbeat({
          type: "arena.connected",
        }),
      )
    }),
    http.get(`${DEMO_BASE}/api/claxedo/process`, () => {
      return HttpResponse.json({
        configs: [
          {
            id: "proc_dev_server",
            name: "Dev Server",
            command: "npm run dev",
            autoStart: true,
            restartOn: "crash",
            portConflict: "kill",
            env: {},
          },
          {
            id: "proc_test_watch",
            name: "Test Watch",
            command: "npm run test:watch",
            autoStart: false,
            restartOn: "never",
            portConflict: "skip",
            env: {},
          },
          {
            id: "proc_db",
            name: "Database",
            command: "docker compose up db",
            autoStart: true,
            restartOn: "crash",
            portConflict: "skip",
            env: {},
          },
        ],
        processes: [],
      })
    }),
    http.post(`${DEMO_BASE}/api/claxedo/process/:id/start`, ({ params }) => {
      return HttpResponse.json({
        configId: params.id,
        status: "running",
        ptyId: `pty_proc_${params.id}`,
        restartCount: 0,
        startedAt: Date.now(),
      })
    }),
    http.post(`${DEMO_BASE}/api/claxedo/process/:id/stop`, ({ params }) => {
      return HttpResponse.json({
        configId: params.id,
        status: "stopped",
        restartCount: 0,
      })
    }),
    http.post(`${DEMO_BASE}/api/claxedo/process/:id/restart`, ({ params }) => {
      return HttpResponse.json({
        configId: params.id,
        status: "running",
        ptyId: `pty_proc_${params.id}`,
        restartCount: 1,
        startedAt: Date.now(),
      })
    }),
    http.get(`${DEMO_BASE}/api/claxedo/bootstrap`, ({ request }) => {
      const dir =
        new URL(request.url).searchParams.get("directory")
        ?? request.headers.get("x-opencode-directory")
        ?? root
      return HttpResponse.json({
        healthy: true,
        version: "0.1.0-demo",
        path: {
          ...state.path,
          worktree: dir,
          directory: dir,
        },
        project: state.projects,
        provider: state.provider,
        provider_auth: state.providerAuth,
        config: state.config,
      })
    }),
    http.get(`${DEMO_BASE}/api/claxedo/diff/vcs`, ({ request }) => {
      const params = new URL(request.url).searchParams
      const directory = params.get("directory") ?? root
      const mode = params.get("mode") ?? "session"
      if (mode === "session" || mode === "session-turn") {
        const project = projectFor(state, directory)
        const sessionId = project ? state.sessions.find((s) => s.directory === directory)?.id : undefined
        return HttpResponse.json(sessionId ? (state.sessionDiffs[sessionId] ?? []) : [])
      }
      return HttpResponse.json([])
    }),
    http.get(`${DEMO_BASE}/api/claxedo/diff/refs`, ({ request }) => {
      const directory = new URL(request.url).searchParams.get("directory") ?? root
      void directory
      return HttpResponse.json({
        branches: ["main", "dev", "feature/auth", "feature/dashboard"],
        tags: ["v1.0.0", "v0.9.0"],
        recent: [
          { hash: "abc1234", subject: "fix: resolve auth middleware bug" },
          { hash: "def5678", subject: "feat: add OAuth provider" },
          { hash: "ghi9012", subject: "chore: update dependencies" },
        ],
      })
    }),
    http.get(`${DEMO_BASE}/api/claxedo/diff/targets`, () => {
      return HttpResponse.json(state.sessionDiffTargets)
    }),
    http.get(`${DEMO_BASE}/api/claxedo/process/diagnostics`, () => {
      return HttpResponse.json({
        summary: {
          managed: { groups: 0, rows: 0, cpu_percent: 0, rss_kb: 0, hidden_children: 0, problem_children: 0 },
          terminal: { groups: 0, rows: 0, cpu_percent: 0, rss_kb: 0, hidden_children: 0, problem_children: 0 },
        },
        managed: [],
        terminal: [],
      })
    }),
    http.post(`${DEMO_BASE}/api/claxedo/process/diagnostics/terminate`, () => {
      return HttpResponse.json({ success: true })
    }),
    http.get(`${DEMO_BASE}/api/claxedo/agent-config/runner`, () => {
      return HttpResponse.json(null)
    }),
    http.get(`${DEMO_BASE}/api/claxedo/agent-config/runner/options`, () => {
      return HttpResponse.json({ options: [], source: "empty", stale: false })
    }),
    http.post(`${DEMO_BASE}/api/claxedo/agent-config/runner/model`, () => {
      return HttpResponse.json({ success: true })
    }),
    http.post(`${DEMO_BASE}/api/claxedo/agent-config/runner`, () => {
      return HttpResponse.json({ success: true })
    }),
    http.get(`${DEMO_BASE}/api/claxedo/session/:id/meta`, () => {
      return HttpResponse.json(null)
    }),
    http.get(`${DEMO_BASE}/api/claxedo/process/logs`, () => {
      return HttpResponse.json([])
    }),
    http.all(`${DEMO_BASE}/*`, ({ request }) => {
      const path = new URL(request.url).pathname
      if (
        path.startsWith("/src/") ||
        path.startsWith("/@") ||
        path.startsWith("/node_modules/") ||
        path === "/__vite_ping" ||
        path === "/" ||
        path.endsWith(".html") ||
        path.endsWith(".css") ||
        path.endsWith(".js") ||
        path.endsWith(".ts") ||
        path.endsWith(".tsx") ||
        path.endsWith(".jsx") ||
        path.endsWith(".svg") ||
        path.endsWith(".png") ||
        path.endsWith(".woff") ||
        path.endsWith(".woff2") ||
        path.endsWith(".map") ||
        path.endsWith(".json")
      ) {
        return passthrough()
      }
      return HttpResponse.json(null)
    }),
  ]
}
