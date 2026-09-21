import { describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createWorkspaceRuntimeApp } from "../server"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"
import { WorkspaceRuntimeRoutes } from "./manifest"
import { JSON_BODY_LIMIT_BYTES, boundedJson, boundedTextBody, errorBody, isRequestBodyTooLarge } from "./http"
import { WorktreeRoutes } from "./worktree"
import { createSessionRoutes } from "./session-core"
import type { WorkspaceWorktreeManager } from "../worktree"
import type { AgentHarnessAdapter } from "@claxedo/agent-sdk-runtime/adapters"

const tooLarge = errorBody("request_body_too_large", "Request body is too large")

/** A body whose declared length is over the cap but whose bytes are not. */
function declaredOversize(payload: unknown): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(JSON_BODY_LIMIT_BYTES + 1),
    },
    body: JSON.stringify(payload),
  }
}

/**
 * A body with no declared length that streams past the cap.
 *
 * `Request` omits `content-length` for a stream, so this is the case the
 * declared-length check cannot see and only the read loop can stop. The stream
 * is cancelled once the reader gives up, so a refusal costs the chunks already
 * sent rather than the whole payload.
 */
function chunkedOversize(): RequestInit & { duplex: "half" } {
  const chunk = new TextEncoder().encode(`"${"x".repeat(64 * 1024)}`)
  let sent = 0
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    duplex: "half",
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > JSON_BODY_LIMIT_BYTES) {
          controller.close()
          return
        }
        sent += chunk.byteLength
        controller.enqueue(chunk)
      },
    }),
  }
}

async function withRuntimeApp(
  run: (app: ReturnType<typeof createWorkspaceRuntimeApp>, directory: string) => Promise<void>,
) {
  const directory = await mkdtemp(path.join(tmpdir(), "workspace-runtime-body-limit-"))
  const previous = process.env.WORKSPACE_RUNTIME_DIRECTORY
  process.env.WORKSPACE_RUNTIME_DIRECTORY = directory
  const runtime = createWorkspaceRuntimeApp({
    exposure: loopbackWorkspaceRuntimeExposure(),
    target: { workspaceId: "ws_body_limit", directory },
    storeRoot: path.join(directory, "state"),
  })
  try {
    await run(runtime, directory)
  } finally {
    await runtime.host.dispose()
    if (previous === undefined) delete process.env.WORKSPACE_RUNTIME_DIRECTORY
    else process.env.WORKSPACE_RUNTIME_DIRECTORY = previous
    await rm(directory, { recursive: true, force: true })
  }
}

describe("strict bounded JSON", () => {
  test("rejects missing, malformed and invalid UTF-8 bodies", async () => {
    await expect(boundedJson(new Request("http://localhost"), 64)).rejects.toThrow("required")
    await expect(boundedJson(new Request("http://localhost", { method: "POST", body: "{" }), 64)).rejects.toBeInstanceOf(SyntaxError)
    const invalid = new Uint8Array([0x22, 0xff, 0x22])
    await expect(boundedJson(new Request("http://localhost", { method: "POST", body: invalid }), 64)).rejects.toBeInstanceOf(TypeError)
  })

  test("shares the byte-limit error and decodes UTF-8 split between chunks", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x22, 0xe2]))
        controller.enqueue(new Uint8Array([0x82, 0xac, 0x22]))
        controller.close()
      },
    })
    const request = new Request("http://localhost", { method: "POST", body })
    expect(await boundedJson(request, 5)).toBe("€")
    expect(request.body?.locked).toBe(false)
    const oversized = new Request("http://localhost", { method: "POST", body: '"€"' })
    const refusal = await boundedJson(oversized, 4).then(() => undefined, (error: unknown) => error)
    expect(isRequestBodyTooLarge(refusal)).toBe(true)
    expect(oversized.body?.locked).toBe(false)
  })
})

describe("boundedTextBody", () => {
  test("stops a stream at the limit instead of accumulating it", async () => {
    const chunk = new Uint8Array(32)
    let produced = 0
    const cancelled = mock(() => {})
    const context = {
      req: {
        header: () => undefined,
        raw: new Request("http://localhost/", {
          method: "POST",
          duplex: "half",
          body: new ReadableStream<Uint8Array>({
            pull(controller) {
              produced += chunk.byteLength
              controller.enqueue(chunk)
            },
            cancel: cancelled,
          }),
        } as RequestInit),
      },
    }

    const refusal = await boundedTextBody(context, 64).then(() => undefined, (error: unknown) => error)
    expect(isRequestBodyTooLarge(refusal)).toBe(true)
    expect(produced).toBeLessThanOrEqual(128)
    expect(cancelled).toHaveBeenCalled()
  })
})

describe("checkpoint routes reject oversized bodies before changing runtime state", () => {
  test("freeze refuses a declared-oversize body and leaves the checkpoint active", async () => {
    await withRuntimeApp(async (runtime) => {
      const response = await runtime.app.request(
        `${WorkspaceRuntimeRoutes.checkpoint}/freeze`,
        declaredOversize({ policy: "interrupt" }),
      )

      expect(response.status).toBe(413)
      await expect(response.json()).resolves.toEqual(tooLarge)
      expect(runtime.host.checkpoint.detail().state).toBe("active")
    })
  })

  test("freeze refuses a chunked-oversize body and leaves the checkpoint active", async () => {
    await withRuntimeApp(async (runtime) => {
      const response = await runtime.app.request(
        `${WorkspaceRuntimeRoutes.checkpoint}/freeze`,
        chunkedOversize(),
      )

      expect(response.status).toBe(413)
      expect(runtime.host.checkpoint.detail().state).toBe("active")
    })
  })

  test("restore-reconcile refuses an oversized body before reading epoch or checkpoint id", async () => {
    await withRuntimeApp(async (runtime) => {
      const response = await runtime.app.request(
        `${WorkspaceRuntimeRoutes.checkpoint}/restore-reconcile`,
        declaredOversize({ epoch: 1, checkpointId: "ckpt_1" }),
      )

      expect(response.status).toBe(413)
      await expect(response.json()).resolves.toEqual(tooLarge)
    })
  })

  test("a malformed body stays a bounded read and keeps its own refusal", async () => {
    await withRuntimeApp(async (runtime) => {
      const response = await runtime.app.request(`${WorkspaceRuntimeRoutes.checkpoint}/restore-reconcile`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{ not json",
      })

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "workspace_checkpoint_reconcile_invalid" },
      })
    })
  })

  test("a valid freeze and resume still round-trip", async () => {
    await withRuntimeApp(async (runtime) => {
      const frozen = await runtime.app.request(`${WorkspaceRuntimeRoutes.checkpoint}/freeze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ policy: "drain" }),
      })

      expect(frozen.status).toBe(200)
      expect(runtime.host.checkpoint.detail().state).not.toBe("active")

      expect((await runtime.app.request(`${WorkspaceRuntimeRoutes.checkpoint}/resume`, {
        method: "POST",
      })).status).toBe(200)
      expect(runtime.host.checkpoint.detail().state).toBe("active")
    })
  })
})

describe("git source commit rejects oversized bodies before touching the repository", () => {
  test("refuses a declared-oversize commit", async () => {
    await withRuntimeApp(async (runtime) => {
      const response = await runtime.app.request(
        `${WorkspaceRuntimeRoutes.git}/commit`,
        declaredOversize({ path: "doc.md", content: "hello", message: "commit" }),
      )

      expect(response.status).toBe(413)
      await expect(response.json()).resolves.toEqual(tooLarge)
    })
  })

  test("refuses a chunked-oversize commit", async () => {
    await withRuntimeApp(async (runtime) => {
      const response = await runtime.app.request(`${WorkspaceRuntimeRoutes.git}/commit`, chunkedOversize())

      expect(response.status).toBe(413)
    })
  })

  test("a malformed commit body keeps its own field refusal", async () => {
    await withRuntimeApp(async (runtime) => {
      const response = await runtime.app.request(`${WorkspaceRuntimeRoutes.git}/commit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{ not json",
      })

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "git_source_path_required" },
      })
    })
  })
})

describe("worktree create rejects oversized bodies before the manager runs", () => {
  function mounted() {
    const ensure = mock(async () => {
      throw new Error("worktree creation must not be reached")
    })
    const manager = { ensure, list: () => [], get: () => undefined } as unknown as WorkspaceWorktreeManager
    const app = new Hono()
    app.route(WorkspaceRuntimeRoutes.worktrees, WorktreeRoutes(manager))
    return { app, ensure }
  }

  test("refuses a declared-oversize create", async () => {
    const { app, ensure } = mounted()

    const response = await app.request(
      WorkspaceRuntimeRoutes.worktrees,
      declaredOversize({ sessionId: "ses_1" }),
    )

    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toEqual(tooLarge)
    expect(ensure).not.toHaveBeenCalled()
  })

  test("refuses a chunked-oversize create", async () => {
    const { app, ensure } = mounted()

    const response = await app.request(WorkspaceRuntimeRoutes.worktrees, chunkedOversize())

    expect(response.status).toBe(413)
    expect(ensure).not.toHaveBeenCalled()
  })

  test("a malformed create body keeps its own field refusal", async () => {
    const { app, ensure } = mounted()

    const response = await app.request(WorkspaceRuntimeRoutes.worktrees, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "worktree_invalid_session" },
    })
    expect(ensure).not.toHaveBeenCalled()
  })

  test("a valid create still reaches the manager", async () => {
    const worktree = {
      workspaceId: "ws_1",
      sessionId: "ses_1",
      branch: "claxedo/session/ses_1",
      baseCommit: "a".repeat(40),
      path: "/worktrees/ses_1",
      state: "active" as const,
      createdAt: 1,
      updatedAt: 1,
      lastActivityAt: 1,
    }
    const ensure = mock(async () => worktree)
    const manager = { ensure, list: () => [], get: () => undefined } as unknown as WorkspaceWorktreeManager
    const app = new Hono()
    app.route(WorkspaceRuntimeRoutes.worktrees, WorktreeRoutes(manager))

    const response = await app.request(WorkspaceRuntimeRoutes.worktrees, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "ses_1" }),
    })

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual({ worktree })
    expect(ensure).toHaveBeenCalledWith({ sessionId: "ses_1" })
  })
})

describe("session routes reject oversized bodies before the provider runs", () => {
  function mounted() {
    const createSession = mock(async () => ({ id: "session_new" }))
    const adapter = {
      instructionChannel: "turn-system-prompt",
      createSession,
      getSession: async () => ({ id: "session_1", title: "T", time: { created: 1, updated: 1 } }),
      readHarnessCapabilities: () => ({ harness: "codex", abort: true }),
    } as unknown as AgentHarnessAdapter
    const app = new Hono()
    app.route("/", createSessionRoutes({
      resolveAdapter: () => adapter,
      resolveDirectory: () => "/tmp/workspace-runtime-body-limit-session",
      resolveExecutionBinding: (_c, directory, sessionId) => ({
        sessionId,
        workspaceId: "ws_body_limit",
        directory: directory ?? "",
        connectionId: "native:codex",
        upstreamSessionId: sessionId,
      }),
      publishGlobal: () => {},
    }))
    return { app, createSession }
  }

  test("create refuses a declared-oversize body before the provider is asked", async () => {
    const { app, createSession } = mounted()

    const response = await app.request("/session", declaredOversize({ title: "new" }))

    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toEqual(tooLarge)
    expect(createSession).not.toHaveBeenCalled()
  })

  test("create refuses a chunked-oversize body before the provider is asked", async () => {
    const { app, createSession } = mounted()

    const response = await app.request("/session", chunkedOversize())

    expect(response.status).toBe(413)
    expect(createSession).not.toHaveBeenCalled()
  })

  test("a valid create still reaches the provider", async () => {
    const { app, createSession } = mounted()

    const response = await app.request("/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "new" }),
    })

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toMatchObject({ id: "session_new" })
    expect(createSession).toHaveBeenCalled()
  })

  // These three answer a request that got past their own guards with a status
  // of their own, so the assertion is that the oversize body never becomes one
  // of those answers: the read is refused first.
  test.each([
    ["/session/session_1/message", { parts: [{ type: "text", text: "hi" }] }],
    ["/session/session_1/prompt_async", { parts: [{ type: "text", text: "hi" }] }],
    ["/session/session_1/queue/1/steer", {}],
  ])("%s refuses an oversized body", async (path, payload) => {
    const { app } = mounted()

    const declared = await app.request(path, declaredOversize(payload))
    expect(declared.status).toBe(413)
    await expect(declared.json()).resolves.toEqual(tooLarge)

    const chunked = await app.request(path, chunkedOversize())
    expect(chunked.status).toBe(413)

    const accepted = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
    expect(accepted.status).not.toBe(413)
  })
})
