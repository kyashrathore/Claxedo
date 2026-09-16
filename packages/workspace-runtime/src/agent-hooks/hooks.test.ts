import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  generateNotifyScript,
  generateAmpPlugin,
  generateAntigravityHook,
  generateGeminiHook,
  generateCursorHook,
  generateCopilotHook,
  generateCopilotProjectHooks,
} from "./core/hooks"
import { AgentHookRoutes } from "../routes/agent-hook"
import { NOTIFY_MARKER } from "./core/constants"
import { workspaceRuntimeBus } from "../bus"

it("Antigravity forwards native stop metadata through shell, HTTP and lifecycle bus", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agy-native-hook-"))
  const terminalId = path.basename(root)
  const events: unknown[] = []
  const unsubscribe = workspaceRuntimeBus.subscribe((event) => {
    if (event.type === "agent.lifecycle" && event.terminalId === terminalId) events.push(event)
  })
  const app = AgentHookRoutes()
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url)
    url.pathname = "/agent-lifecycle"
    return app.fetch(new Request(url, request))
  } })
  try {
    const notify = path.join(root, "notify.sh")
    const hook = path.join(root, "antigravity-hook.sh")
    await writeFile(notify, generateNotifyScript(server.port!))
    await writeFile(hook, generateAntigravityHook(notify))
    for (const [name, fields] of [
      ["PreInvocation", {}],
      ["Stop", { fullyIdle: false, terminationReason: "model_stop" }],
      ["Stop", { fullyIdle: true, terminationReason: "model_stop" }],
    ] as const) {
      const child = Bun.spawn(["bash", hook, name], {
        env: { ...process.env, CLAXEDO_TAB_ID: terminalId, CLAXEDO_TERMINAL_ID: terminalId, CLAXEDO_SERVER_PORT: String(server.port) },
        stdin: new Blob([JSON.stringify({ conversationId: "agy-native", transcriptPath: '/tmp/quoted "path"/π.jsonl', ...fields })]),
        stdout: "pipe", stderr: "pipe",
      })
      expect(await child.exited).toBe(0)
      expect(await new Response(child.stdout).text()).toBe("{}\n")
      expect(await new Response(child.stderr).text()).toBe("")
    }
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ provider: "antigravity", providerSessionId: "agy-native", eventType: "Busy" })
    expect(events[1]).toMatchObject({ provider: "antigravity", eventType: "Idle", outcome: "done" })
  } finally {
    unsubscribe()
    await server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})

it("Amp plugin delivers awaited native events through the real notification transport", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "amp-native-hook-"))
  const terminalId = path.basename(root)
  const events: unknown[] = []
  const unsubscribe = workspaceRuntimeBus.subscribe((event) => {
    if (event.type === "agent.lifecycle" && event.terminalId === terminalId) events.push(event)
  })
  const app = AgentHookRoutes()
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url)
    url.pathname = "/agent-lifecycle"
    return app.fetch(new Request(url, request))
  } })
  try {
    await mkdir(path.join(root, "hooks"))
    await writeFile(path.join(root, "hooks", "notify.sh"), generateNotifyScript(server.port!))
    await writeFile(path.join(root, "plugin.ts"), generateAmpPlugin())
    await writeFile(path.join(root, "run.ts"), `
      import plugin from "./plugin"
      const handlers = new Map()
      plugin({ on: (name, handler) => handlers.set(name, handler), logger: { log: console.error } })
      const event = { thread: { id: "T-native" }, id: "M-1", message: 'quoted "prompt"\\nπ' }
      for (const status of ["done", "cancelled", "error"]) {
        await handlers.get("agent.start")(event)
        await handlers.get("agent.end")({ ...event, status, messages: [] })
      }
    `)
    const child = Bun.spawn([process.execPath, path.join(root, "run.ts")], {
      env: { ...process.env, CLAXEDO_HOME_DIR: root, CLAXEDO_TAB_ID: terminalId, CLAXEDO_TERMINAL_ID: terminalId, CLAXEDO_SERVER_PORT: String(server.port) },
      stdout: "ignore", stderr: "pipe",
    })
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stderr).text()).toBe("")
    expect(events).toHaveLength(6)
    expect(events[1]).toMatchObject({ provider: "amp", providerSessionId: "T-native", eventType: "Idle", outcome: "done" })
    expect(events[3]).toMatchObject({ eventType: "Idle", outcome: "cancelled" })
    expect(events[5]).toMatchObject({ eventType: "Error", outcome: "error" })
  } finally {
    unsubscribe()
    await server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})

// ── Notify script ───────────────────────────────────────────────────────────

describe("generateNotifyScript", () => {
  it("delivers a real shell hook with workspace routing identity outside the form body", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claxedo-notify-test-"))
    let delivered: { workspace: string | null; terminal: string | null; event: string | null } | undefined
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        // The dispatcher selects a workspace before its runtime parses the form.
        const workspace = request.headers.get("x-workspace-id")
        if (!workspace) return new Response("Workspace not routed", { status: 404 })
        const form = new URLSearchParams(await request.text())
        delivered = { workspace, terminal: form.get("terminalId"), event: JSON.parse(form.get("providerEvent")!).type }
        return Response.json({ success: true })
      },
    })
    try {
      const script = path.join(root, "notify.sh")
      await writeFile(script, generateNotifyScript(server.port!))
      const child = Bun.spawn(["/bin/bash", script, JSON.stringify({ type: "agent-turn-complete" })], {
        env: {
          ...process.env,
          CLAXEDO_SERVER_PORT: String(server.port),
          CLAXEDO_WORKSPACE_ID: "ws_notify_test",
          CLAXEDO_TERMINAL_ID: "pty_notify_test",
          CLAXEDO_TAB_ID: "tab_notify_test",
          WORKSPACE_RUNTIME_STATE_DIR: root,
        },
        stdout: "ignore", stderr: "pipe",
      })
      expect(await child.exited).toBe(0)
      const deadline = Date.now() + 3000
      const settled = () => delivered !== undefined
      while (!settled() && Date.now() < deadline) await Bun.sleep(20)
      expect(delivered).toEqual({ workspace: "ws_notify_test", terminal: "pty_notify_test", event: "agent-turn-complete" })
    } finally {
      await server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  })

  it("keeps the parent busy when a Claude subagent stops", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claxedo-child-hook-"))
    const app = AgentHookRoutes()
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(request) {
        const url = new URL(request.url)
        url.pathname = "/agent-lifecycle"
        return app.fetch(new Request(url, request))
      },
    })
    try {
      const script = path.join(root, "notify.sh")
      await writeFile(script, generateNotifyScript(server.port!))
      const invoke = async (hook_event_name: string) => {
        const child = Bun.spawn(["/bin/bash", script, JSON.stringify({ hook_event_name, session_id: "parent", agent_id: "child" })], {
          env: { ...process.env, CLAXEDO_SERVER_PORT: String(server.port), CLAXEDO_TAB_ID: "tab", CLAXEDO_TERMINAL_ID: "parent", WORKSPACE_RUNTIME_STATE_DIR: root },
          stdout: "ignore", stderr: "ignore",
        })
        expect(await child.exited).toBe(0)
      }
      await invoke("UserPromptSubmit")
      const state = async () => (await (await app.request("http://localhost/terminal-session?terminalId=parent")).json()).session.eventType
      expect(await state()).toBe("Busy")
      await invoke("SubagentStop")
      expect(await state()).toBe("Busy")
      await invoke("Stop")
      expect(await state()).toBe("Idle")
    } finally {
      await server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  })

  it("delivers only the config owned by the terminal's agent and labels an unwrapped launch", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claxedo-harness-gate-"))
    const delivered: { provider: string | null; event: string | null }[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        const form = new URLSearchParams(await request.text())
        delivered.push({ provider: form.get("provider"), event: JSON.parse(form.get("providerEvent")!).hook_event_name })
        return Response.json({ success: true })
      },
    })
    try {
      const script = path.join(root, "notify.sh")
      await writeFile(script, generateNotifyScript(server.port!))
      const invoke = async (args: string[], env: Record<string, string>) => {
        const child = Bun.spawn(["/bin/bash", script, ...args], {
          env: { ...process.env, CLAXEDO_AGENT: "", CURSOR_VERSION: "", CLAXEDO_SERVER_PORT: String(server.port), CLAXEDO_TAB_ID: "tab", CLAXEDO_TERMINAL_ID: "pty", WORKSPACE_RUNTIME_STATE_DIR: root, ...env },
          stdin: "ignore", stdout: "ignore", stderr: "ignore",
        })
        return await child.exited
      }
      const stop = JSON.stringify({ hook_event_name: "Stop" })
      const postToolUse = JSON.stringify({ hook_event_name: "postToolUse", tool_name: "Read" })
      // Cursor replays ~/.claude/settings.json inside its own sessions.
      expect(await invoke(["--harness=claude", postToolUse], { CLAXEDO_AGENT: "cursor-agent" })).toBe(0)
      // Claude's Bash tool running `codex exec` fires Codex's config under a Claude terminal.
      expect(await invoke(["--harness=codex", stop], { CLAXEDO_AGENT: "claude" })).toBe(0)
      expect(delivered).toEqual([])
      expect(await invoke(["--harness=cursor", stop], { CLAXEDO_AGENT: "cursor-agent" })).toBe(0)
      expect(await invoke(["--harness=claude", stop], { CLAXEDO_AGENT: "claude" })).toBe(0)
      // Launched by absolute path, outside the wrapper: the config names the agent...
      expect(await invoke(["--harness=droid", stop], {})).toBe(0)
      // ...unless it is Claude's config replayed by cursor-agent, which stamps CURSOR_VERSION.
      expect(await invoke(["--harness=claude", stop], { CURSOR_VERSION: "2026.09.10" })).toBe(0)
      // A config with no label keeps today's delivery.
      expect(await invoke([stop], { CLAXEDO_AGENT: "gemini" })).toBe(0)
      expect(delivered).toEqual([
        { provider: "cursor-agent", event: "Stop" },
        { provider: "claude", event: "Stop" },
        { provider: "droid", event: "Stop" },
        { provider: "gemini", event: "Stop" },
      ])
    } finally {
      await server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  })

  it("includes marker and port", () => {
    const script = generateNotifyScript(7860)
    expect(script).toContain(NOTIFY_MARKER)
    expect(script).toContain("7860")
  })

  it("reports failed delivery and sends a later completion again", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claxedo-hook-retry-"))
    let requests = 0
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch() { return new Response("", { status: ++requests === 1 ? 503 : 200 }) },
    })
    try {
      const script = path.join(root, "notify.sh")
      await writeFile(script, generateNotifyScript(server.port!))
      const invoke = () => Bun.spawn(["/bin/bash", script, JSON.stringify({ hook_event_name: "Stop" })], {
        env: { ...process.env, CLAXEDO_TAB_ID: "retry-tab", CLAXEDO_SERVER_PORT: String(server.port), WORKSPACE_RUNTIME_STATE_DIR: root },
        stdout: "ignore", stderr: "ignore",
      }).exited
      expect(await invoke()).not.toBe(0)
      expect(await invoke()).toBe(0)
      expect(requests).toBe(2)
    } finally {
      await server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  })

  it("posts lifecycle mutations with the terminal-scoped capability", () => {
    const script = generateNotifyScript(7860)
    expect(script).toContain('curl -fsS "$HOOK_URL"')
    expect(script).toContain('--request POST')
    expect(script).toContain('Authorization: Bearer $CLAXEDO_AGENT_HOOK_TOKEN')
  })
})

// ── Hook bridge generators ──────────────────────────────────────────────────

describe("generateGeminiHook", () => {
  it("includes marker and notify path", () => {
    const script = generateGeminiHook("/tmp/hooks/notify.sh")
    expect(script).toContain(NOTIFY_MARKER)
    expect(script).toContain("/tmp/hooks/notify.sh")
  })
})

describe("generateCursorHook", () => {
  it("includes marker and notify path", () => {
    const script = generateCursorHook("/tmp/hooks/notify.sh")
    expect(script).toContain(NOTIFY_MARKER)
    expect(script).toContain("/tmp/hooks/notify.sh")
  })

  it("forwards each Cursor event under the cursor harness and answers the permission hooks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claxedo-cursor-hook-"))
    const app = AgentHookRoutes()
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const url = new URL(request.url)
      url.pathname = "/agent-lifecycle"
      return app.fetch(new Request(url, request))
    } })
    try {
      const notify = path.join(root, "notify.sh")
      const hook = path.join(root, "cursor-hook.sh")
      await writeFile(notify, generateNotifyScript(server.port!))
      await writeFile(hook, generateCursorHook(notify))
      const terminalId = path.basename(root)
      const run = async (arg: string, payload: Record<string, unknown>) => {
        const child = Bun.spawn(["/bin/bash", hook, arg], {
          env: { ...process.env, CLAXEDO_AGENT: "cursor-agent", CLAXEDO_SERVER_PORT: String(server.port), CLAXEDO_TAB_ID: terminalId, CLAXEDO_TERMINAL_ID: terminalId, WORKSPACE_RUNTIME_STATE_DIR: root },
          stdin: new Blob([JSON.stringify({ conversation_id: "conv-1", ...payload })]), stdout: "pipe", stderr: "ignore",
        })
        const reply = await new Response(child.stdout).text()
        expect(await child.exited).toBe(0)
        return reply.trim()
      }
      const state = async () => (await (await app.request(`http://localhost/terminal-session?terminalId=${terminalId}`)).json()).session.eventType
      expect(await run("Start", { hook_event_name: "beforeSubmitPrompt", prompt: "run the tests" })).toBe("{}")
      expect(await state()).toBe("Busy")
      expect(await run("PermissionRequest", { hook_event_name: "beforeShellExecution", command: "bun test", cwd: root })).toBe('{"continue":true}')
      expect(await state()).toBe("UserActionRequired")
      expect(await run("PostToolUse", { hook_event_name: "postToolUseFailure", tool_name: "Shell", tool_input: { command: "bun test", cwd: root }, failure_type: "permission_denied" })).toBe("{}")
      expect(await state()).toBe("Busy")
      expect(await run("Stop", { hook_event_name: "stop", status: "completed" })).toBe("{}")
      expect(await state()).toBe("Idle")
    } finally {
      await server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("generateCopilotHook", () => {
  it("includes marker and notify path", () => {
    const script = generateCopilotHook("/tmp/hooks/notify.sh")
    expect(script).toContain(NOTIFY_MARKER)
    expect(script).toContain("/tmp/hooks/notify.sh")
  })
})

// ── Copilot project hooks ───────────────────────────────────────────────────

describe("generateCopilotProjectHooks", () => {
  it("produces valid JSON with all lifecycle events", () => {
    const json = generateCopilotProjectHooks("/tmp/hooks/copilot-hook.sh")
    const parsed = JSON.parse(json)
    expect(parsed.version).toBe(1)
    expect(parsed.hooks.sessionStart).toBeDefined()
    expect(parsed.hooks.sessionEnd).toBeDefined()
    expect(parsed.hooks.userPromptSubmitted).toBeDefined()
    expect(parsed.hooks.postToolUse).toBeDefined()
  })

  it("embeds the hook script path in commands", () => {
    const json = generateCopilotProjectHooks("/tmp/hooks/copilot-hook.sh")
    expect(json).toContain("/tmp/hooks/copilot-hook.sh")
  })
})

for (const [provider, generate, event, argument] of [
  ["gemini", generateGeminiHook, "BeforeAgent", ""],
  ["cursor", generateCursorHook, "beforeSubmitPrompt", "Start"],
] as const) {
  it(`${provider} forwards complete provider JSON and waits for the HTTP acknowledgement`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claxedo-provider-hook-"))
    let received: string | null = null
    let acknowledged = false
    const payload = JSON.stringify({ hook_event_name: event, conversation_id: "conversation", session_id: "provider-session", prompt: 'Keep "quotes" and\nnewlines', transcript_path: "/tmp/provider-session.jsonl" }, null, 2)
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        received = new URLSearchParams(await request.text()).get("providerEvent")
        await Bun.sleep(100)
        acknowledged = true
        return Response.json({ success: true })
      },
    })
    try {
      const notify = path.join(root, "notify.sh")
      const script = path.join(root, "hook.sh")
      await writeFile(notify, generateNotifyScript(server.port!), { mode: 0o700 })
      await writeFile(script, generate(notify))
      const child = Bun.spawn(["/bin/bash", script, argument], {
        stdin: new Blob([payload]), stdout: "pipe", stderr: "pipe",
        env: { ...process.env, CLAXEDO_SERVER_PORT: String(server.port), CLAXEDO_TAB_ID: "provider-hook-tab", CLAXEDO_TERMINAL_ID: "provider-hook-terminal", CLAXEDO_AGENT: provider },
      })
      expect(await child.exited).toBe(0)
      expect(acknowledged, "The next provider hook must not overtake an unacknowledged event").toBe(true)
      expect<string | null>(received).toBe(payload)
      expect(JSON.parse(await new Response(child.stdout).text())).toEqual({})
    } finally {
      await server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  })
}
