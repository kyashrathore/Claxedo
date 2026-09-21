import { describe, expect, spyOn, test } from "bun:test"
import { Hono } from "hono"
import { workspaceRuntimeBus, type WorkspaceRuntimeEvent } from "../bus"
import { AgentHookRoutes, lifecycleLogMetadata, TERMINAL_SESSION_MAX_ENTRIES } from "./agent-hook"
import { errorBody, JSON_BODY_LIMIT_BYTES } from "./http"
import { managedWorkspaceSessionAccessPolicy, type SessionAccessPolicy } from "../session-access-policy"
import type { RelayHostAuthContext } from "../workspace-host-service-auth"
import { Pty } from "../pty/index"
import { withWorkspaceTarget } from "../target"
import { workspaceRuntimeEventSessionId } from "./session-event-privacy"

const runningTerminal = (id: string, sessionId?: string) => ({
  id,
  ...(sessionId ? { sessionId } : {}),
  title: id,
  command: "/bin/sh",
  args: [],
  cwd: "/tmp",
  status: "running" as const,
  pid: 1,
})

const liveTerminals = (...ids: string[]) => {
  const live = new Set(ids)
  return spyOn(Pty, "get").mockImplementation((id) => (live.has(id) ? runningTerminal(id) : undefined))
}

test("raw provider hooks keep background waits busy and deduplicate only accepted completion", async () => {
  const app = AgentHookRoutes()
  const terminalId = "pty_raw_background"
  const get = liveTerminals(terminalId)
  const events: unknown[] = []
  const unsubscribe = workspaceRuntimeBus.subscribe((event) => {
    if (event.type === "agent.lifecycle" && event.terminalId === terminalId) events.push(event)
  })
  const post = (providerEvent: unknown) => app.request("http://localhost/agent-lifecycle", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tabId: "tab_raw_background", terminalId, provider: "claude", providerEvent: JSON.stringify(providerEvent) }),
  })
  const status = async () => (await (await app.request(`http://localhost/terminal-session?terminalId=${terminalId}`)).json()).session.eventType
  try {
    expect((await post({ hook_event_name: "UserPromptSubmit", prompt: 'Use "quoted" paths\nπ' })).status).toBe(200)
    expect(await status()).toBe("Busy")
    expect((await post({ hook_event_name: "Stop", background_tasks: [{ id: "child", status: "running" }] })).status).toBe(200)
    expect(await status()).toBe("Busy")
    expect((await post({ hook_event_name: "SubagentStop" })).status).toBe(200)
    expect(await status()).toBe("Busy")
    expect(events).toHaveLength(1)
    // A rejected completion must not suppress the next valid completion.
    expect((await post({ hook_event_name: "Stop", session_id: "x".repeat(513) })).status).toBe(400)
    expect(await status()).toBe("Busy")
    expect((await post({ hook_event_name: "Stop", background_tasks: [] })).status).toBe(200)
    expect(await status()).toBe("Idle")
    expect((await post({ hook_event_name: "Stop", background_tasks: [] })).status).toBe(200)
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ eventType: "Busy", prompt: 'Use "quoted" paths\nπ' })
    expect(events[1]).toMatchObject({ eventType: "Idle" })
    expect(events.every((event) => !Object.hasOwn(event as object, "providerEvent"))).toBe(true)
    expect((await post(["not", "an", "object"])).status).toBe(400)
  } finally {
    unsubscribe()
    get.mockRestore()
  }
})

test("a pending ask survives unrelated tool completions and retires with its own", async () => {
  const app = AgentHookRoutes()
  const terminalId = "pty_raw_pending_ask"
  const get = liveTerminals(terminalId)
  const events: unknown[] = []
  const unsubscribe = workspaceRuntimeBus.subscribe((event) => {
    if (event.type === "agent.lifecycle" && event.terminalId === terminalId) events.push(event)
  })
  const post = (providerEvent: unknown) => app.request("http://localhost/agent-lifecycle", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tabId: "tab_raw_pending_ask", terminalId, provider: "cursor-agent", providerEvent: JSON.stringify(providerEvent) }),
  })
  const status = async () => (await (await app.request(`http://localhost/terminal-session?terminalId=${terminalId}`)).json()).session
  try {
    // Cursor's session log, 2026-09-15: two shell asks, then Claude-compat
    // postToolUse for an earlier Read and a parallel Grep, before any approval.
    await post({ hook_event_name: "beforeSubmitPrompt", prompt: "add task_edit" })
    expect((await post({ hook_event_name: "beforeShellExecution", command: "bun run test -- a.test.ts", cwd: "/repo" })).status).toBe(200)
    expect((await post({ hook_event_name: "beforeShellExecution", command: "bun run test -- b.test.ts", cwd: "/repo" })).status).toBe(200)
    expect((await status()).eventType).toBe("UserActionRequired")
    expect(await (await post({ hook_event_name: "postToolUse", tool_name: "Read", tool_input: { path: "/repo/x.ts" }, tool_use_id: "t1" })).json()).toMatchObject({ held: true })
    expect(await (await post({ hook_event_name: "postToolUse", tool_name: "Grep", tool_input: { pattern: "task_edit" }, tool_use_id: "t2" })).json()).toMatchObject({ held: true })
    expect((await status()).eventType).toBe("UserActionRequired")
    expect(events.map((event) => (event as { eventType: string }).eventType)).toEqual(["Busy", "UserActionRequired", "UserActionRequired"])
    // Approving the second command first leaves the first still waiting.
    expect(await (await post({ hook_event_name: "postToolUse", tool_name: "Shell", tool_input: { command: "bun run test -- b.test.ts", cwd: "/repo" }, tool_use_id: "t4" })).json()).toMatchObject({ held: true })
    expect((await status()).eventType).toBe("UserActionRequired")
    expect(await (await post({ hook_event_name: "postToolUse", tool_name: "Shell", tool_input: { command: "bun run test -- a.test.ts", cwd: "/repo" }, tool_use_id: "t3" })).json()).toMatchObject({ eventType: "Busy" })
    expect((await status()).eventType).toBe("Busy")
    expect((await status()).pendingUserActions).toBeUndefined()
    // A turn boundary retires an ask that never paired (denied, or unpairable).
    await post({ hook_event_name: "beforeShellExecution", command: "rm -rf build", cwd: "/repo" })
    expect((await status()).eventType).toBe("UserActionRequired")
    expect((await post({ hook_event_name: "stop" })).status).toBe(200)
    expect((await status()).eventType).toBe("Idle")
    await post({ hook_event_name: "postToolUse", tool_name: "Read", tool_input: { path: "/repo/y.ts" } })
    expect((await status()).eventType).toBe("Busy")
    expect(events.every((event) => !("userAction" in (event as object)) && !("toolCompletion" in (event as object)))).toBe(true)
  } finally {
    unsubscribe()
    get.mockRestore()
  }
})

test("a denial or failure retires only its own ask, and tool hooks never rebind the terminal's session", async () => {
  const app = AgentHookRoutes()
  const terminalId = "pty_raw_deny_and_bind"
  const get = liveTerminals(terminalId)
  const events: unknown[] = []
  const unsubscribe = workspaceRuntimeBus.subscribe((event) => {
    if (event.type === "agent.lifecycle" && event.terminalId === terminalId) events.push(event)
  })
  const post = (providerEvent: unknown) => app.request("http://localhost/agent-lifecycle", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tabId: "tab_raw_deny_and_bind", terminalId, provider: "claude", providerEvent: JSON.stringify(providerEvent) }),
  })
  const session = async () => (await (await app.request(`http://localhost/terminal-session?terminalId=${terminalId}`)).json()).session
  try {
    await post({ hook_event_name: "UserPromptSubmit", session_id: "parent", prompt: "ship it" })
    await post({ hook_event_name: "PermissionRequest", session_id: "parent", tool_name: "Bash", tool_input: { command: "rm -rf dist" } })
    await post({ hook_event_name: "PermissionRequest", session_id: "parent", tool_name: "Edit", tool_input: { file_path: "/repo/a.ts", old_string: "x", new_string: "y" } })
    expect((await session()).eventType).toBe("UserActionRequired")
    // An unrelated tool erroring mid-turn is not the turn's failure and keeps both asks open.
    expect(await (await post({ hook_event_name: "PostToolUseFailure", session_id: "parent", tool_name: "Grep", tool_input: { pattern: "x" }, error: "no matches" })).json()).toMatchObject({ held: true })
    expect((await session()).eventType).toBe("UserActionRequired")
    // A subagent's shell command reports the child's session; the binding stays with the parent.
    expect(await (await post({ hook_event_name: "PostToolUse", session_id: "child-agent", agent_id: "child", tool_name: "Bash", tool_input: { command: "ls" } })).json()).toMatchObject({ held: true })
    expect((await session()).sessionId).toBe("parent")
    // Denying the shell command retires that ask; the edit is still waiting.
    expect(await (await post({ hook_event_name: "PermissionDenied", session_id: "parent", tool_name: "Bash", tool_input: { command: "rm -rf dist" }, reason: "user" })).json()).toMatchObject({ held: true })
    expect((await session()).eventType).toBe("UserActionRequired")
    const approved = await (await post({ hook_event_name: "PostToolUse", session_id: "parent", tool_name: "Edit", tool_input: { file_path: "/repo/a.ts", old_string: "x", new_string: "y" }, tool_use_id: "t2" })).json()
    expect(approved).toMatchObject({ eventType: "Busy", sessionId: "parent" })
    expect((await session()).eventType).toBe("Busy")
    // With nothing pending a subagent's ask and completion publish, still under the parent's session.
    expect(await (await post({ hook_event_name: "PermissionRequest", session_id: "child-agent", agent_id: "child", tool_name: "Bash", tool_input: { command: "ls" } })).json()).toMatchObject({ eventType: "UserActionRequired", sessionId: "parent" })
    expect(await (await post({ hook_event_name: "PostToolUse", session_id: "child-agent", agent_id: "child", tool_name: "Bash", tool_input: { command: "ls" } })).json()).toMatchObject({ eventType: "Busy", sessionId: "parent" })
    expect((await session()).sessionId).toBe("parent")
    expect(events.map((event) => (event as { sessionId?: string }).sessionId)).toEqual(["parent", "parent", "parent", "parent", "parent", "parent"])
    expect(events.every((event) => (event as { providerSessionId?: string }).providerSessionId === "parent")).toBe(true)
    // The turn's own failure still ends it.
    await post({ hook_event_name: "StopFailure", session_id: "parent" })
    expect((await session()).eventType).toBe("Error")
  } finally {
    unsubscribe()
    get.mockRestore()
  }
})

function privateSessionPolicy(owners: Record<string, string>): SessionAccessPolicy {
  const allowed = (actorId: string | undefined, sessionId: string | undefined) =>
    !!sessionId && owners[sessionId] === actorId
  return {
    sessionAuthority: "managed-private",
    authorizeSessionStartStatus: () => ({ allowed: false as const, status: 403 as const, code: "startup_not_tested", message: "Startup is not admitted by this fixture" }),
    authorizeSessionStart: () => ({ allowed: false as const, status: 403 as const, code: "startup_not_tested", message: "Startup is not admitted by this fixture" }),
    authorize: async (input) => allowed(input.actor?.actorId, input.sessionId)
      ? { allowed: true }
      : { allowed: false, status: 403, code: "private_session", message: "Session is private" },
    filterSessions: async (input) => input.sessionIds.filter((sessionId) => allowed(input.actor?.actorId, sessionId)),
    authorizePrefix: async () => ({ allowed: true }),
  }
}

function relayAuth(
  actorId: string,
  role: NonNullable<RelayHostAuthContext["relayHostAuth"]>["role"] = "editor",
): NonNullable<RelayHostAuthContext["relayHostAuth"]> {
  const now = Math.floor(Date.now() / 1000)
  return {
    iss: "workspace-relay",
    aud: "workspace-host-service",
    principal_kind: "user",
    actor_id: actorId,
    actor_kind: "human",
    org_id: "org_1",
    workspace_id: "ws_1",
    host_id: "host_1",
    role,
    backing: "cloud-vm",
    exp: now + 60,
    iat: now,
    jti: `jti_${actorId}`,
    parent_jti: "rat_jti_1",
  }
}

const managedPolicy = managedWorkspaceSessionAccessPolicy({
  requireActor: true,
  authority: {
    authorizeSessionRead: () => true,
    authorizeSessionWrite: () => true,
    authorizeSessionStream: (_input, lease) => ({
      allowed: true,
      lease: lease ? `${lease}:renewed` : "terminal-lease",
      expiresAt: Date.now() + 15_000,
    }),
    registerSession: () => true,
    acquireTurn: (input) => ({
      allowed: true,
      turnId: input.turnId,
      leaseId: "turn_lease_1",
      fencingToken: 1,
      acquiredAt: Date.now(),
      expiresAt: Date.now() + 15_000,
    }),
    renewTurn: (input) => ({
      allowed: true,
      turnId: input.turnId,
      leaseId: input.leaseId,
      fencingToken: input.fencingToken + 1,
      acquiredAt: Date.now(),
      expiresAt: Date.now() + 15_000,
    }),
    releaseTurn: () => ({ released: true }),
  },
})
managedPolicy.authorizeHost = async (input) => {
  const rank = { viewer: 0, editor: 1, admin: 2, owner: 3 } as const
  return input.authority && rank[input.authority.role] >= rank[input.minimumRole]
    ? { allowed: true }
    : { allowed: false, status: 403, code: "host_authority_denied", message: "Current host authority is required" }
}

function managedApp(
  actorId: string,
  policyOrRole: SessionAccessPolicy | NonNullable<RelayHostAuthContext["relayHostAuth"]>["role"] = managedPolicy,
) {
  const policy = typeof policyOrRole === "string" ? managedPolicy : policyOrRole
  const role = typeof policyOrRole === "string" ? policyOrRole : "editor"
  const app = new Hono<{ Variables: RelayHostAuthContext }>()
  app.use("*", async (c, next) => {
    c.set("relayHostAuth", relayAuth(actorId, role))
    return await next()
  })
  app.route("/", AgentHookRoutes({ sessionAccessPolicy: policy }))
  return app
}

function directHookApp(policy: SessionAccessPolicy = managedPolicy) {
  const app = new Hono<{ Variables: RelayHostAuthContext }>()
  app.use("*", async (c, next) => {
    c.set("relayHostDirectAuth", true)
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
    expect((await AgentHookRoutes().request("http://localhost/agent-lifecycle?tabId=leaked&eventType=Busy")).status).toBe(405)
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
    const get = spyOn(Pty, "get").mockImplementation((id) => id === terminalId
      ? {
          id: terminalId,
          sessionId: "session_a",
          title: "private",
          command: "/bin/sh",
          args: [],
          cwd: "/tmp",
          status: "running",
          pid: 1,
        }
      : undefined)
    const terminalOwner = spyOn(Pty, "accessOwner").mockReturnValue("editor_a")
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
      get.mockRestore()
      terminalOwner.mockRestore()
    }
  })

  test("publishes derived terminal ref names instead of weak first prompts", async () => {
    const app = AgentHookRoutes()
    const get = liveTerminals("pty_title_test")
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
    get.mockRestore()

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
    const get = liveTerminals("pty_noise_title_test")
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
    get.mockRestore()
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
    const get = liveTerminals(
      first,
      ...Array.from({ length: TERMINAL_SESSION_MAX_ENTRIES }, (_, index) => `pty_cache_${index}`),
    )
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
      get.mockRestore()
    }
  })

  test("logs lifecycle shape without terminal-child content or paths", async () => {
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
    const get = liveTerminals("pty_log_redaction")
    const prompt = "private prompt sentinel"
    const assistant = "private assistant sentinel"
    const transcriptPath = "/private/transcript/sentinel.jsonl"
    try {
      const response = await AgentHookRoutes().request("http://localhost/agent-lifecycle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tabId: "tab_log_redaction",
          terminalId: "pty_log_redaction",
          provider: "codex",
          sessionId: "provider_session_log_redaction",
          prompt,
          lastAssistantMessage: assistant,
          transcriptPath,
          eventType: "Idle",
        }),
      })
      expect(response.status).toBe(200)
      const output = stderr.mock.calls.map((call) => String(call[0])).join("\n")
      expect(output).toContain("provider=codex")
      expect(output).toContain("eventType=Idle")
      expect(output).toContain("hasPrompt=true")
      expect(output).toContain("hasLastAssistantMessage=true")
      expect(output).not.toContain("hasTranscriptPath")
      expect(output).not.toContain(prompt)
      expect(output).not.toContain(assistant)
      expect(output).not.toContain(transcriptPath)
      expect(output).toContain("sessionId=provider_session_log_redaction")
    } finally {
      stderr.mockRestore()
      get.mockRestore()
    }
  })

  test("GET lifecycle is read-only and directs canonical producers to POST", async () => {
    const app = AgentHookRoutes()
    const events: unknown[] = []
    const unsubscribe = workspaceRuntimeBus.subscribe((event) => {
      if (event.type === "agent.lifecycle" && event.terminalId === "pty_get_is_read_only") events.push(event)
    })
    const params = new URLSearchParams({
      tabId: "tab_get_is_read_only",
      terminalId: "pty_get_is_read_only",
      eventType: "Start",
    })

    const response = await app.request(`http://localhost/agent-lifecycle?${params}`)
    unsubscribe()

    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toBe("POST")
    expect(events).toHaveLength(0)
    const metadata = await app.request("http://localhost/terminal-session?terminalId=pty_get_is_read_only")
    await expect(metadata.json()).resolves.toMatchObject({ source: "none", session: null })
  })

  test("managed lifecycle writes bind to the runtime-recorded terminal owner and canonical workspace", async () => {
    const get = spyOn(Pty, "get").mockImplementation((id) => id === "pty_owned"
      ? {
          id,
          sessionId: "session_canonical",
          title: "owned",
          command: "/bin/sh",
          args: [],
          cwd: "/tmp",
          status: "running",
          pid: 1,
        }
      : undefined)
    let managedBound = false
    const owner = spyOn(Pty, "accessOwner").mockImplementation((id) => id === "pty_owned" && managedBound ? "actor_owner" : undefined)
    const events: unknown[] = []
    let unsubscribe = () => {}
    try {
      // Even if an unmanaged producer populated the same in-memory row first,
      // entering managed mode must erase that caller-provided scope.
      expect((await AgentHookRoutes().request("http://localhost/agent-lifecycle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tabId: "tab_owned",
          terminalId: "pty_owned",
          eventType: "Busy",
          sessionId: "forged_stale_scope",
        }),
      })).status).toBe(200)
      managedBound = true
      unsubscribe = workspaceRuntimeBus.subscribe((event) => {
        if (event.type === "agent.lifecycle" && event.terminalId === "pty_owned") events.push(event)
      })
      const payload = {
        tabId: "tab_owned",
        terminalId: "pty_owned",
        workspaceId: "caller_forged_workspace",
        provider: "codex",
        sessionId: "provider_session_not_private_authority_id",
        eventType: "Busy",
      }
      const allowed = await managedApp("actor_owner").request("http://localhost/agent-lifecycle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
      expect(allowed.status).toBe(200)
      expect(events).toEqual([expect.objectContaining({
        workspaceId: "ws_1",
        terminalId: "pty_owned",
        providerSessionId: "provider_session_not_private_authority_id",
        sessionId: "session_canonical",
      })])
      expect(workspaceRuntimeEventSessionId(events[0] as never)).toBe("session_canonical")
      const metadata = await managedApp("actor_owner").request("http://localhost/terminal-session?terminalId=pty_owned")
      const metadataBody = await metadata.json() as { session?: { sessionId?: string; providerSessionId?: string } }
      expect(metadataBody.session).toMatchObject({ providerSessionId: "provider_session_not_private_authority_id" })
      expect(metadataBody.session?.sessionId).toBe("session_canonical")

      const unverifiedOverwrite = await AgentHookRoutes().request("http://localhost/agent-lifecycle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tabId: "tab_owned",
          terminalId: "pty_owned",
          eventType: "Busy",
          sessionId: "second_forged_scope",
        }),
      })
      expect(unverifiedOverwrite.status).toBe(403)

      const attacker = await managedApp("actor_attacker").request("http://localhost/agent-lifecycle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
      expect(attacker.status).toBe(403)
      await expect(attacker.json()).resolves.toMatchObject({ error: { code: "agent_terminal_private" } })
      expect(events).toHaveLength(1)
    } finally {
      unsubscribe()
      get.mockRestore()
      owner.mockRestore()
    }
  })

  test("an unattributed lifecycle write stamps the runtime's canonical workspace and the terminal's bound session, never the caller's claims", async () => {
    const terminalId = "pty_unverified_canonical"
    const get = spyOn(Pty, "get").mockImplementation((id) => id === terminalId
      ? { id, sessionId: "session_bound", title: id, command: "/bin/sh", args: [], cwd: "/tmp", status: "running" as const, pid: 1 }
      : undefined)
    const owner = spyOn(Pty, "accessOwner").mockReturnValue(undefined)
    const events: Extract<WorkspaceRuntimeEvent, { type: "agent.lifecycle" }>[] = []
    const unsubscribe = workspaceRuntimeBus.subscribe((event) => {
      if (event.type === "agent.lifecycle" && event.terminalId === terminalId) events.push(event)
    })
    try {
      const response = await withWorkspaceTarget({ workspaceId: "ws_canonical", directory: "/tmp" }, () =>
        AgentHookRoutes().request("http://localhost/agent-lifecycle", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            tabId: "tab_unverified",
            terminalId,
            workspaceId: "forged_workspace",
            provider: "claude",
            sessionId: "forged_session",
            transcriptPath: "/transcripts/forged.jsonl",
            eventType: "Busy",
          }),
        }))
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ sessionId: "session_bound" })
      expect(events).toEqual([expect.objectContaining({
        workspaceId: "ws_canonical",
        sessionId: "session_bound",
        providerSessionId: "forged_session",
      })])
      expect(workspaceRuntimeEventSessionId(events[0])).toBe("session_bound")
      // The terminal's stored record carries the same canonical ownership.
      const metadata = await AgentHookRoutes().request(`http://localhost/terminal-session?terminalId=${terminalId}`)
      const body = await metadata.json() as { session?: { sessionId?: string; workspaceId?: string } }
      expect(body.session).toMatchObject({ sessionId: "session_bound", workspaceId: "ws_canonical" })
    } finally {
      unsubscribe()
      get.mockRestore()
      owner.mockRestore()
    }
  })

  test("managed terminal metadata is private to its recorded owner while administrators retain oversight", async () => {
    const get = spyOn(Pty, "get").mockReturnValue({
      id: "pty_metadata",
      title: "metadata",
      command: "/bin/sh",
      args: [],
      cwd: "/tmp",
      status: "running",
      pid: 1,
    })
    const owner = spyOn(Pty, "accessOwner").mockReturnValue("actor_owner")
    try {
      const write = await managedApp("actor_owner").request("http://localhost/agent-lifecycle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tabId: "tab_metadata",
          terminalId: "pty_metadata",
          provider: "claude",
          sessionId: "provider_session_private",
          transcriptPath: "/private/transcript.jsonl",
          eventType: "Idle",
        }),
      })
      expect(write.status).toBe(200)

      const attacker = await managedApp("actor_attacker").request("http://localhost/terminal-session?terminalId=pty_metadata")
      expect(attacker.status).toBe(403)
      await expect(attacker.json()).resolves.toMatchObject({ error: { code: "agent_terminal_private" } })

      const ownerRead = await managedApp("actor_owner").request("http://localhost/terminal-session?terminalId=pty_metadata")
      expect(ownerRead.status).toBe(200)
      const ownerBody = await ownerRead.json() as { session?: { sessionId?: string; providerSessionId?: string; transcriptPath?: string } }
      expect(ownerBody).toMatchObject({
        session: {
          providerSessionId: "provider_session_private",
          transcriptPath: "/private/transcript.jsonl",
        },
      })
      expect(ownerBody.session?.sessionId).toBeUndefined()

      const adminRead = await managedApp("actor_admin", "admin").request("http://localhost/terminal-session?terminalId=pty_metadata")
      expect(adminRead.status).toBe(200)
    } finally {
      get.mockRestore()
      owner.mockRestore()
    }
  })

  test("managed lifecycle rejects unknown terminals before publishing or storing caller metadata", async () => {
    const get = spyOn(Pty, "get").mockReturnValue(undefined)
    const owner = spyOn(Pty, "accessOwner").mockReturnValue(undefined)
    const events: unknown[] = []
    const unsubscribe = workspaceRuntimeBus.subscribe((event) => {
      if (event.type === "agent.lifecycle" && event.terminalId === "pty_unknown") events.push(event)
    })
    try {
      const response = await managedApp("actor_owner").request("http://localhost/agent-lifecycle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tabId: "tab_unknown", terminalId: "pty_unknown", eventType: "Busy" }),
      })
      expect(response.status).toBe(403)
      expect(events).toHaveLength(0)
    } finally {
      unsubscribe()
      get.mockRestore()
      owner.mockRestore()
    }
  })

  test("managed lifecycle rejects writes after the runtime PTY has exited", async () => {
    const get = spyOn(Pty, "get").mockReturnValue({
      id: "pty_exited",
      title: "exited",
      command: "/bin/sh",
      args: [],
      cwd: "/tmp",
      status: "exited",
      pid: 1,
    })
    const owner = spyOn(Pty, "accessOwner").mockReturnValue("actor_owner")
    try {
      const response = await managedApp("actor_owner").request("http://localhost/agent-lifecycle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tabId: "tab_exited",
          terminalId: "pty_exited",
          eventType: "Busy",
        }),
      })
      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toMatchObject({ error: { code: "agent_terminal_private" } })
    } finally {
      get.mockRestore()
      owner.mockRestore()
    }
  })

  test("unmanaged lifecycle writes name a live terminal and present its bound capability", async () => {
    const get = spyOn(Pty, "get").mockImplementation((id) => {
      if (id === "pty_live" || id === "pty_bound" || id === "pty_bound_unowned" || id === "pty_other") {
        return runningTerminal(id, `session_${id}`)
      }
      if (id === "pty_exited_unmanaged") return { ...runningTerminal(id), status: "exited" as const }
      return undefined
    })
    const boundToken = spyOn(Pty, "agentHookToken").mockImplementation((id) =>
      id === "pty_bound" || id === "pty_bound_unowned" ? `hook_${id}` : id === "pty_other" ? "hook_other" : undefined)
    const owner = spyOn(Pty, "accessOwner").mockImplementation((id) => (id === "pty_bound" ? "actor_owner" : undefined))
    const hookAccess = (terminalId: string, token: string) => ({
      terminalId,
      token,
      context: {
        actor: { actorId: "actor_owner", actorKind: "human" as const },
        authority: { managed: true as const, workspaceId: "ws_1", orgId: "org_1", role: "editor" as const },
      },
      sessionId: `session_${terminalId}`,
      authorityLease: `lease_${terminalId}`,
      authorityExpiresAt: Date.now() + 15_000,
    })
    const access = spyOn(Pty, "agentHookAccessForToken").mockImplementation((token) =>
      token === "hook_pty_bound" ? hookAccess("pty_bound", token) : token === "hook_other" ? hookAccess("pty_other", token) : undefined)
    const renew = spyOn(Pty, "renewAgentHookAccess").mockReturnValue(true)
    const events: unknown[] = []
    const unsubscribe = workspaceRuntimeBus.subscribe((event) => {
      if (event.type === "agent.lifecycle") events.push(event)
    })
    const post = (app: Hono<{ Variables: RelayHostAuthContext }>, terminalId: string, token?: string) =>
      app.request("http://localhost/agent-lifecycle", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ tabId: `tab_${terminalId}`, terminalId, eventType: "Busy" }),
      })
    try {
      const app = AgentHookRoutes()
      const direct = directHookApp()
      // A terminal the runtime has no session for cannot be named at all.
      expect((await post(app, "pty_missing")).status).toBe(403)
      // A stale terminal rejects writes the same way the managed path does.
      expect((await post(app, "pty_exited_unmanaged")).status).toBe(403)
      // A capability-bound terminal answers only to its own token, owner or not.
      expect((await post(app, "pty_bound")).status).toBe(403)
      expect((await post(app, "pty_bound_unowned")).status).toBe(403)
      expect((await post(direct, "pty_bound", "hook_other")).status).toBe(403)
      expect((await post(direct, "pty_bound_unowned", "hook_other")).status).toBe(403)
      // A live terminal with no bound capability keeps the local producer path.
      expect((await post(app, "pty_live")).status).toBe(200)
      // The terminal's own bound token still authorizes the callback.
      expect((await post(direct, "pty_bound", "hook_pty_bound")).status).toBe(200)
      expect(events).toHaveLength(2)
    } finally {
      unsubscribe()
      get.mockRestore()
      boundToken.mockRestore()
      owner.mockRestore()
      access.mockRestore()
      renew.mockRestore()
    }
  })

  test("accepts only the terminal-scoped direct callback capability and derives claims from runtime state", async () => {
    const get = spyOn(Pty, "get").mockReturnValue({
      id: "pty_direct",
      sessionId: "session_private",
      title: "direct",
      command: "/bin/sh",
      args: [],
      cwd: "/tmp",
      status: "running",
      pid: 1,
    })
    const owner = spyOn(Pty, "accessOwner").mockReturnValue("actor_owner")
    const access = spyOn(Pty, "agentHookAccessForToken").mockImplementation((token) => token === "hook_capability"
      ? {
          terminalId: "pty_direct",
          token: "hook_capability",
          context: {
            actor: { actorId: "actor_owner", actorKind: "human" },
            authority: { managed: true, workspaceId: "ws_1", orgId: "org_1", role: "editor" },
          },
          sessionId: "session_private",
          authorityLease: "terminal-lease",
          authorityExpiresAt: Date.now() + 15_000,
        }
      : undefined)
    const renew = spyOn(Pty, "renewAgentHookAccess").mockReturnValue(true)
    try {
      const allowed = await directHookApp().request("http://localhost/agent-lifecycle", {
        method: "POST",
        headers: { authorization: "Bearer hook_capability", "content-type": "application/json" },
        body: JSON.stringify({
          tabId: "tab_direct",
          terminalId: "pty_direct",
          eventType: "Busy",
          sessionId: "forged_private",
        }),
      })
      expect(allowed.status).toBe(200)

      const wrongTerminal = await directHookApp().request("http://localhost/agent-lifecycle", {
        method: "POST",
        headers: { authorization: "Bearer hook_capability", "content-type": "application/json" },
        body: JSON.stringify({ tabId: "tab_other", terminalId: "pty_other", eventType: "Busy" }),
      })
      expect(wrongTerminal.status).toBe(403)
    } finally {
      get.mockRestore()
      owner.mockRestore()
      access.mockRestore()
      renew.mockRestore()
    }
  })

  test("revokes a terminal callback before publication when capability renewal is denied", async () => {
    const policy = { ...managedPolicy }
    policy.authorizeStream = async () => ({
      allowed: false,
      status: 403,
      code: "runtime_access_token_revoked",
      message: "Terminal owner no longer has workspace access",
    })
    const get = spyOn(Pty, "get").mockReturnValue({
      id: "pty_revoked",
      sessionId: "session_revoked",
      title: "revoked",
      command: "/bin/sh",
      args: [],
      cwd: "/tmp",
      status: "running",
      pid: 1,
    })
    const owner = spyOn(Pty, "accessOwner").mockReturnValue("actor_revoked")
    const access = spyOn(Pty, "agentHookAccessForToken").mockReturnValue({
      terminalId: "pty_revoked",
      token: "hook_revoked",
      context: {
        actor: { actorId: "actor_revoked", actorKind: "human" },
        authority: { managed: true, workspaceId: "ws_1", orgId: "org_1", role: "editor" },
      },
      sessionId: "session_revoked",
      authorityLease: "expired-lease",
      authorityExpiresAt: Date.now() - 1,
    })
    const renew = spyOn(Pty, "renewAgentHookAccess")
    const events: unknown[] = []
    const unsubscribe = workspaceRuntimeBus.subscribe((event) => {
      if (event.type === "agent.lifecycle" && event.terminalId === "pty_revoked") events.push(event)
    })
    try {
      const response = await directHookApp(policy).request("http://localhost/agent-lifecycle", {
        method: "POST",
        headers: { authorization: "Bearer hook_revoked", "content-type": "application/json" },
        body: JSON.stringify({ tabId: "tab_revoked", terminalId: "pty_revoked", eventType: "Busy" }),
      })
      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toMatchObject({ error: { code: "runtime_access_token_revoked" } })
      expect(renew).not.toHaveBeenCalled()
      expect(events).toHaveLength(0)
    } finally {
      unsubscribe()
      get.mockRestore()
      owner.mockRestore()
      access.mockRestore()
      renew.mockRestore()
    }
  })

  test("allows managed setup status reads but reserves setup writes for administrators", async () => {
    const status = await managedApp("actor_viewer", "viewer").request("http://localhost/setup/status")
    expect(status.status).toBe(200)

    const setup = await managedApp("actor_editor", "editor").request("http://localhost/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(setup.status).toBe(403)
    await expect(setup.json()).resolves.toMatchObject({ error: { code: "host_authority_denied" } })
  })
})
