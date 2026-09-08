import { describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  generateNotifyScript,
  generateGeminiHook,
  generateCursorHook,
  generateCopilotHook,
  generateCopilotProjectHooks,
} from "./core/hooks"
import { NOTIFY_MARKER } from "./core/constants"

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
        delivered = { workspace, terminal: form.get("terminalId"), event: form.get("eventType") }
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
      while (!delivered && Date.now() < deadline) await Bun.sleep(20)
      expect(delivered).toEqual({ workspace: "ws_notify_test", terminal: "pty_notify_test", event: "Idle" })
    } finally {
      server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  })

  it("keeps the parent busy when a Claude subagent stops", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claxedo-child-hook-"))
    const events: string[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        events.push(new URLSearchParams(await request.text()).get("eventType")!)
        return Response.json({ success: true })
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
      const deadline = Date.now() + 3000
      while (!events.length && Date.now() < deadline) await Bun.sleep(20)
      expect(events).toEqual(["Busy"])
      await invoke("SubagentStop")
      expect(await readFile(path.join(root, "parent.agent"), "utf8")).toBe("busy\n")
      await invoke("Stop")
      const settled = Date.now() + 3000
      while (events.length < 2 && Date.now() < settled) await Bun.sleep(20)
      expect(events).toEqual(["Busy", "Idle"])
      expect(await readFile(path.join(root, "parent.agent"), "utf8")).toBe("idle\n")
    } finally {
      server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  })

  it("includes marker and port", () => {
    const script = generateNotifyScript(7860)
    expect(script).toContain(NOTIFY_MARKER)
    expect(script).toContain("7860")
  })

  it("normalizes Codex SessionStart events", () => {
    const script = generateNotifyScript(7860)
    expect(script).toContain('"SessionStart"')
    expect(script).toContain('"SessionEnd"')
  })

  it("posts lifecycle mutations with the terminal-scoped capability", () => {
    const script = generateNotifyScript(7860)
    expect(script).toContain('curl -s "$HOOK_URL"')
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
