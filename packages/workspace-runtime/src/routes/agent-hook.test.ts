import { describe, expect, spyOn, test } from "bun:test"
import { Hono } from "hono"
import { workspaceRuntimeBus } from "../bus"
import { AgentHookRoutes, lifecycleLogMetadata, TERMINAL_SESSION_MAX_ENTRIES } from "./agent-hook"
import { errorBody, JSON_BODY_LIMIT_BYTES } from "./http"
import { managedWorkspaceSessionAccessPolicy, type SessionAccessPolicy } from "../session-access-policy"
import type { RelayHostAuthContext } from "../workspace-host-service-auth"

function privateSessionPolicy(owners: Record<string, string>): SessionAccessPolicy {
  const allowed = (actorId: string | undefined, sessionId: string | undefined) =>
    !!sessionId && owners[sessionId] === actorId
  return {
    sessionAuthority: "managed-private",
    authorize: async (input) => allowed(input.actor?.actorId, input.sessionId)
      ? { allowed: true }
      : { allowed: false, status: 403, code: "private_session", message: "Session is private" },
    filterSessions: async (input) => input.sessionIds.filter((sessionId) => allowed(input.actor?.actorId, sessionId)),
    authorizePrefix: async () => ({ allowed: true }),
  }
}

function managedApp(actorId: string, policy: SessionAccessPolicy) {
  const app = new Hono<{ Variables: RelayHostAuthContext }>()
  app.use("*", async (c, next) => {
    c.set("relayHostAuth", {
      iss: "workspace-relay",
      aud: "workspace-host-service",
      sub: actorId,
      org_id: "org_1",
      workspace_id: "workspace_1",
      host_id: "host_1",
      role: "editor",
      access: "cloud",
      backing: "cloud-vm",
      exp: Math.floor(Date.now() / 1000) + 60,
      iat: Math.floor(Date.now() / 1000),
      jti: `jti_${actorId}`,
      actor_id: actorId,
      actor_kind: "human",
    })
    return await next()
  })
  app.route("/", AgentHookRoutes({ sessionAccessPolicy: policy }))
  return app
}

describe("AgentHookRoutes", () => {
  const postLifecycle = (app: ReturnType<typeof AgentHookRoutes>, body: URLSearchParams) => app.request(
    "http://localhost/agent-lifecycle",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
  )

  test("never includes transcript content or paths in lifecycle logs", () => {
    const metadata = lifecycleLogMetadata({
      tabId: "tab_private",
      terminalId: "pty_private",
      workspaceId: "workspace_private",
      provider: "codex",
      sessionId: "session_private",
      transcriptPath: "/private/transcript.jsonl",
      refName: "@private-customer-name",
      prompt: "private customer prompt",
      lastAssistantMessage: "private assistant response",
      eventType: "Idle",
    })

    expect(metadata).toEqual({
      tabId: "tab_private",
      terminalId: "pty_private",
      workspaceId: "workspace_private",
      provider: "codex",
      sessionId: "session_private",
      eventType: "Idle",
      hasPrompt: true,
      hasLastAssistantMessage: true,
    })
    expect(JSON.stringify(metadata)).not.toContain("private customer prompt")
    expect(JSON.stringify(metadata)).not.toContain("private assistant response")
    expect(JSON.stringify(metadata)).not.toContain("/private/transcript.jsonl")
    expect(JSON.stringify(metadata)).not.toContain("@private-customer-name")
  })

  test("exposes lifecycle ingestion as POST-only", async () => {
    expect((await AgentHookRoutes().request("http://localhost/agent-lifecycle?tabId=leaked&eventType=Busy")).status).toBe(404)
  })

  test("denies actor-less managed lifecycle writes and ignores body actor fields", async () => {
    const response = await AgentHookRoutes({
      sessionAccessPolicy: managedWorkspaceSessionAccessPolicy({ requireActor: true }),
    }).request("http://localhost/agent-lifecycle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tabId: "tab_1",
        eventType: "Busy",
        sessionId: "session_1",
        actor_id: "body_actor",
        actor_kind: "human",
      }),
    })

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: {
        code: "session_actor_required",
        message: "Managed session access requires verified actor claims",
      },
    })
  })

  test("keeps lifecycle prompt and assistant content private between editors", async () => {
    const terminalId = "pty_private_hook"
    const policy = privateSessionPolicy({ session_a: "editor_a", session_b: "editor_b" })
    const editorA = managedApp("editor_a", policy)
    const editorB = managedApp("editor_b", policy)
    const events: unknown[] = []
    const unsubscribe = workspaceRuntimeBus.subscribe((event) => {
      if (event.type === "agent.lifecycle" && event.terminalId === terminalId) events.push(event)
    })

    try {
      const published = await editorA.request("http://localhost/agent-lifecycle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tabId: "tab_private_hook",
          terminalId,
          sessionId: "session_a",
          eventType: "Idle",
          prompt: "private prompt",
          lastAssistantMessage: "private assistant response",
        }),
      })
      expect(published.status).toBe(200)

      const owner = await editorA.request(`http://localhost/terminal-session?terminalId=${terminalId}`)
      expect(owner.status).toBe(200)
      await expect(owner.json()).resolves.toMatchObject({
        session: {
          sessionId: "session_a",
          prompt: "private prompt",
          lastAssistantMessage: "private assistant response",
        },
      })

      expect((await editorB.request(`http://localhost/terminal-session?terminalId=${terminalId}`)).status).toBe(403)
      expect((await editorB.request("http://localhost/agent-lifecycle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tabId: "tab_private_hook",
          terminalId,
          sessionId: "session_a",
          eventType: "Idle",
          prompt: "attacker prompt",
        }),
      })).status).toBe(403)
      expect((await editorB.request("http://localhost/agent-lifecycle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tabId: "tab_private_hook",
          terminalId,
          sessionId: "session_b",
          eventType: "Idle",
          prompt: "attacker-owned session",
        }),
      })).status).toBe(403)
      expect((await editorA.request("http://localhost/agent-lifecycle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tabId: "tab_missing_session",
          terminalId: "pty_missing_session",
          eventType: "Idle",
          lastAssistantMessage: "unbound content",
        }),
      })).status).toBe(403)

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        sessionId: "session_a",
        prompt: "private prompt",
        lastAssistantMessage: "private assistant response",
      })
      const preserved = await editorA.request(`http://localhost/terminal-session?terminalId=${terminalId}`)
      await expect(preserved.json()).resolves.toMatchObject({
        session: {
          sessionId: "session_a",
          prompt: "private prompt",
        },
      })
    } finally {
      unsubscribe()
    }
  })

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
    expect((await postLifecycle(app, start)).status).toBe(200)

    const idle = new URLSearchParams({
      tabId: "tab_title_test",
      terminalId: "pty_title_test",
      provider: "claude",
      eventType: "Stop",
      lastAssistantMessage: "I can help review the terminal title propagation path.",
    })
    expect((await postLifecycle(app, idle)).status).toBe(200)
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

    expect((await postLifecycle(app, params)).status).toBe(200)

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

    const form = await app.request("http://localhost/agent-lifecycle", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": String(JSON_BODY_LIMIT_BYTES + 1),
      },
      body: "tabId=tab_big&eventType=Busy",
    })
    expect(form.status).toBe(413)
    await expect(form.json()).resolves.toEqual(errorBody("request_body_too_large", "Request body is too large"))
  })

  test("bounds retained terminal lifecycle sessions", async () => {
    const app = AgentHookRoutes()
    const first = "pty_cache_oldest"
    const write = spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      expect((await postLifecycle(app, new URLSearchParams({
        tabId: "tab_cache_oldest",
        terminalId: first,
        eventType: "Busy",
      }))).status).toBe(200)
      for (let index = 0; index < TERMINAL_SESSION_MAX_ENTRIES; index += 1) {
        expect((await postLifecycle(app, new URLSearchParams({
          tabId: `tab_cache_${index}`,
          terminalId: `pty_cache_${index}`,
          eventType: "Busy",
        }))).status).toBe(200)
      }

      const evicted = await app.request(`http://localhost/terminal-session?terminalId=${first}`)
      await expect(evicted.json()).resolves.toMatchObject({ source: "none", session: null })
    } finally {
      write.mockRestore()
    }
  })
})
