import { describe, expect, test } from "bun:test"
import { workspaceRuntimeBus } from "../bus"
import { AgentHookRoutes } from "./agent-hook"
import { errorBody, JSON_BODY_LIMIT_BYTES } from "./http"

describe("AgentHookRoutes", () => {
  test("publishes derived terminal ref names instead of weak first prompts", async () => {
    const app = AgentHookRoutes()
    const events: unknown[] = []
    const unsubscribe = workspaceRuntimeBus.subscribe((event) => {
      if (event.type === "agent.lifecycle" && event.terminalId === "pty_title_test") events.push(event)
    })

    const start = new URLSearchParams({
      tabId: "tab_title_test",
      terminalId: "pty_title_test",
      provider: "claude",
      eventType: "Start",
      prompt: "hi",
    })
    expect((await app.request(`http://localhost/agent-lifecycle?${start}`)).status).toBe(200)

    const idle = new URLSearchParams({
      tabId: "tab_title_test",
      terminalId: "pty_title_test",
      provider: "claude",
      eventType: "Stop",
      lastAssistantMessage: "I can help review the terminal title propagation path.",
    })
    expect((await app.request(`http://localhost/agent-lifecycle?${idle}`)).status).toBe(200)
    unsubscribe()

    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({
      type: "agent.lifecycle",
      terminalId: "pty_title_test",
      refName: "@review-terminal-title",
      prompt: "hi",
      lastAssistantMessage: "I can help review the terminal title propagation path.",
      eventType: "Idle",
    })

    const preview = await app.request("http://localhost/terminal-session?terminalId=pty_title_test")
    await expect(preview.json()).resolves.toMatchObject({
      success: true,
      session: {
        refName: "@review-terminal-title",
      },
    })
  })

  test("derives ref names from assistant text when captured prompt is terminal noise", async () => {
    const app = AgentHookRoutes()
    const params = new URLSearchParams({
      tabId: "tab_noise_title_test",
      terminalId: "pty_noise_title_test",
      provider: "codex",
      eventType: "Stop",
      prompt: "Claude is an AI assistant made by Anthropic. I'm Claude, running as Claude Code for software engineering tasks.",
      lastAssistantMessage: "I'm Codex, a coding agent based on GPT-5.",
    })

    expect((await app.request(`http://localhost/agent-lifecycle?${params}`)).status).toBe(200)

    const preview = await app.request("http://localhost/terminal-session?terminalId=pty_noise_title_test")
    await expect(preview.json()).resolves.toMatchObject({
      success: true,
      session: {
        refName: "@codex-coding-agent",
      },
    })
  })

  test("rejects oversized lifecycle bodies", async () => {
    const app = AgentHookRoutes()
    const events: unknown[] = []
    const unsubscribe = workspaceRuntimeBus.subscribe((event) => {
      if (event.type === "agent.lifecycle") events.push(event)
    })

    const res = await app.request("http://localhost/agent-lifecycle", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(JSON_BODY_LIMIT_BYTES + 1),
      },
      body: JSON.stringify({ tabId: "tab_big", eventType: "Busy" }),
    })
    unsubscribe()

    expect(res.status).toBe(413)
    await expect(res.json()).resolves.toEqual(errorBody("request_body_too_large", "Request body is too large"))
    expect(events).toHaveLength(0)
  })
})
