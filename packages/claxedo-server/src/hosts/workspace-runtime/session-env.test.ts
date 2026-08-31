import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const mocks = vi.hoisted(() => ({
  ensureEmbeddedWorkspaceRuntime: vi.fn(),
  resolveWorkspace: vi.fn(),
  embeddedFetch: vi.fn(),
}))

// The embedded runtime is reached through the composed port, so these cases
// install one rather than mocking a deployment module by path. `mocks.
// ensureEmbeddedWorkspaceRuntime` still drives it, so each case keeps setting
// up its runtime exactly as before.
import { configureLocalWorkspaceRuntime } from "@claxedo/server-core/workspace/local-runtime-port"

configureLocalWorkspaceRuntime({
  async fetch(ws, request) {
    const runtime = await mocks.ensureEmbeddedWorkspaceRuntime(ws)
    return runtime.app.fetch(request)
  },
})

vi.mock("@claxedo/server-core/workspace/store/index", () => ({
  resolveWorkspace: mocks.resolveWorkspace,
}))

import type { SandboxFetchOptions } from "@claxedo/server-core/workspace/http/sandbox-target-fetch"
import type { RelayProvider } from "@claxedo/server-core/adapters/relay-port"
import type { SandboxManagerPort } from "@claxedo/server-core/sandbox/manager-port"
import {
  createClaxedoSessionEnvFactory,
  createWorkspaceRuntimeSessionEnv,
  prepareWorkspaceRuntimeSession,
  WorkspaceRuntimeExecLimitError,
  WorkspaceRuntimeProtocolError,
  WorkspaceRuntimeRequestError,
} from "./session-env"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import { CONNECTION_TURN_HEADER, createConnectionTurnCredentials } from "../../connections/turn-credentials"

type FetchCall = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
import {
  disposeHydratedSessionDocuments,
  forgetHydratedSessionRuntime,
  hydrateSessionDocument,
  hydratedSessionDocumentPaths,
} from "../../documents/session-hydration"
import { sessionEnvBashTool } from "../../../../agent-sdk-runtime/src/harnesses/pi/model-backend"
import { SESSION_ENV_EXEC_MAX_FRAME_BYTES } from "@claxedo/workspace-runtime/session-env-contract"

// Embedded (local) workspace — dispatches in-process via
// ensureEmbeddedWorkspaceRuntime(...).app.fetch. Used by the behaviour tests
// that only care about request framing / fold / file ops.
const workspace: Workspace = {
  id: "ws-1",
  kind: "local",
  directory: "/tmp/demo",
  created_at: 1,
  updated_at: 1,
}

// Cloud workspace — exercises the cached sandboxManager/relayProvider path.
const cloudWorkspace: Workspace = {
  id: "ws-cloud",
  kind: "cloud",
  org_id: "org-1",
  directory: "/workspace",
  created_at: 1,
  updated_at: 1,
}

const fetchOptions: SandboxFetchOptions = {}

function b64(text: string) {
  return Buffer.from(text, "utf8").toString("base64")
}

function b64Bytes(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64")
}

function ndjsonResponse(frames: unknown[]): Response {
  const body =
    frames
      .map((frame) => {
        if (frame && typeof frame === "object" && (frame as { type?: unknown }).type === "exit") {
          return JSON.stringify({ signal: null, ...frame })
        }
        return JSON.stringify(frame)
      })
      .join("\n") + "\n"
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function requestUrl(input: RequestInfo | URL) {
  return input instanceof Request ? input.url : input.toString()
}

/** Grabs the requestPath (1st arg to app.fetch's Request) + init from the last embedded fetch. */
function lastEmbeddedCall() {
  const call = mocks.embeddedFetch.mock.calls.at(-1)!
  const request: unknown = call[0]
  if (!(request instanceof Request)) throw new Error("expected embedded runtime Request")
  const url = new URL(request.url)
  return { path: `${url.pathname}${url.search}`, request }
}

function mockEmbeddedResponse(response: Response) {
  mocks.embeddedFetch.mockResolvedValue(response)
  mocks.ensureEmbeddedWorkspaceRuntime.mockResolvedValue({ app: { fetch: mocks.embeddedFetch } })
}

describe("createClaxedoSessionEnvFactory", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveWorkspace.mockResolvedValue(workspace)
  })

  test("returns a virtual env for an undefined tool sandbox", async () => {
    const factory = createClaxedoSessionEnvFactory({ fetchOptions })
    const env = await factory({ sessionId: "s1", mode: "hybrid", host: "central" })
    expect(env.kind).toBe("virtual")
    expect(mocks.resolveWorkspace).not.toHaveBeenCalled()
  })

  test("propagates only the active turn credential to workspace-runtime requests", async () => {
    const turns = createConnectionTurnCredentials({ random: () => "turn-credential" })
    const factory = createClaxedoSessionEnvFactory({ fetchOptions, turnCredentials: turns })
    const env = await factory({
      sessionId: "s1",
      mode: "hybrid",
      host: "central",
      toolSandbox: { kind: "workspace-runtime", workspaceId: "ws-1" },
    })
    mockEmbeddedResponse(ndjsonResponse([{ type: "exit", exitCode: 0 }]))
    const credential = turns.mint({ sessionId: "s1", subject: "user-a" })

    await turns.run(credential, () => env.exec("printf hi"))

    expect(lastEmbeddedCall().request.headers.get(CONNECTION_TURN_HEADER)).toBe(credential)
    turns.dispose()
  })

  test("returns a virtual env for a virtual tool sandbox", async () => {
    const factory = createClaxedoSessionEnvFactory({ fetchOptions })
    const env = await factory({
      sessionId: "s1",
      mode: "hybrid",
      host: "central",
      toolSandbox: { kind: "virtual", id: "central-pi" },
    })
    expect(env.kind).toBe("virtual")
    expect(mocks.resolveWorkspace).not.toHaveBeenCalled()
  })

  test("returns a workspace-runtime env for a workspace-runtime tool sandbox", async () => {
    const factory = createClaxedoSessionEnvFactory({ fetchOptions })
    const env = await factory({
      sessionId: "s1",
      mode: "hybrid",
      host: "central",
      toolSandbox: { kind: "workspace-runtime", workspaceId: "ws-1" },
    })
    expect(env.kind).toBe("workspace-runtime")
    expect(mocks.resolveWorkspace).toHaveBeenCalledWith({ workspaceId: "ws-1" })
  })

  test("routes admitted absolute worktrees as registered runtime roots", async () => {
    const factory = createClaxedoSessionEnvFactory({ fetchOptions })
    const env = await factory({
      sessionId: "s-worktree",
      mode: "hybrid",
      host: "central",
      toolSandbox: {
        kind: "workspace-runtime",
        workspaceId: "ws-1",
        directory: "/home/runtime/.claxedo/workspaces/ws-1/worktrees/s-worktree",
        worktree: "claxedo/session/s-worktree",
        baseCommit: "a".repeat(40),
        leaseEpoch: 2,
      },
    })
    mockEmbeddedResponse(jsonResponse({ exists: true }))

    await expect(env.exists("README.md")).resolves.toBe(true)
    expect(lastEmbeddedCall().request.headers.get("x-opencode-directory")).toBe(
      "/home/runtime/.claxedo/workspaces/ws-1/worktrees/s-worktree",
    )
    expect(new URL(lastEmbeddedCall().request.url).searchParams.get("path")).toBe("README.md")
  })

  test("routes admitted Windows worktrees as registered runtime roots", async () => {
    const factory = createClaxedoSessionEnvFactory({ fetchOptions })
    const env = await factory({
      sessionId: "s-worktree-win",
      mode: "hybrid",
      host: "central",
      toolSandbox: {
        kind: "workspace-runtime",
        workspaceId: "ws-1",
        directory: "C:\\workspace\\tree",
        worktree: "claxedo/session/s-worktree-win",
        baseCommit: "a".repeat(40),
        leaseEpoch: 2,
      },
    })
    mockEmbeddedResponse(jsonResponse({ exists: true }))

    await expect(env.exists("README.md")).resolves.toBe(true)
    expect(lastEmbeddedCall().request.headers.get("x-opencode-directory")).toBe("C:\\workspace\\tree")
    expect(new URL(lastEmbeddedCall().request.url).searchParams.get("path")).toBe("README.md")
  })

  test("throws for an unknown workspace", async () => {
    mocks.resolveWorkspace.mockResolvedValue(undefined)
    const factory = createClaxedoSessionEnvFactory({ fetchOptions })
    await expect(
      factory({
        sessionId: "s1",
        mode: "hybrid",
        host: "central",
        toolSandbox: { kind: "workspace-runtime", workspaceId: "ws-missing" },
      }),
    ).rejects.toThrow("workspace not found for tool sandbox: ws-missing")
  })

  test("uses an injected workspace resolver instead of the local store", async () => {
    const injected = vi.fn(async () => workspace)
    const factory = createClaxedoSessionEnvFactory({ fetchOptions, resolveWorkspace: injected })
    const env = await factory({
      sessionId: "s1",
      mode: "hybrid",
      host: "central",
      toolSandbox: { kind: "workspace-runtime", workspaceId: "ws-1" },
    })
    expect(env.kind).toBe("workspace-runtime")
    expect(injected).toHaveBeenCalledWith({ workspaceId: "ws-1" })
    expect(mocks.resolveWorkspace).not.toHaveBeenCalled()
  })

  test("a real session bash turn syncs its hydrated document edit and disposes the session copy", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "document-session-roundtrip-"))
    const canonicalFile = path.join(root, "canonical.md")
    const sessionRoot = path.join(root, "workspace")
    await fs.mkdir(sessionRoot)
    await fs.writeFile(canonicalFile, "before")
    const hydrated = await hydrateSessionDocument({
      sessionId: "session-roundtrip",
      workspaceRoot: sessionRoot,
      documentId: "document-a",
      displayName: "Plan",
      markdown: "before",
      baseVersion: "version-1",
      sync: async (markdown) => {
        await fs.writeFile(canonicalFile, markdown)
        return "version-2"
      },
    })
    const env = await createClaxedoSessionEnvFactory({ fetchOptions })({
      sessionId: "session-roundtrip",
      mode: "hybrid",
      host: "central",
      toolSandbox: { kind: "workspace-runtime", workspaceId: "ws-1" },
    })
    mocks.ensureEmbeddedWorkspaceRuntime.mockResolvedValue({
      app: {
        fetch: async () => {
          await fs.writeFile(hydrated, "agent edit")
          return ndjsonResponse([{ type: "exit", exitCode: 0 }])
        },
      },
    })

    await sessionEnvBashTool(env).execute(
      "tool-call-document-edit",
      { command: `printf 'agent edit' > '${hydrated}'` },
      new AbortController().signal,
    )
    expect(await fs.readFile(canonicalFile, "utf8")).toBe("agent edit")
    expect(hydratedSessionDocumentPaths("session-roundtrip")).toEqual([hydrated])
    await env.dispose?.()
    expect(hydratedSessionDocumentPaths("session-roundtrip")).toEqual([])
    await disposeHydratedSessionDocuments("session-roundtrip")
    await fs.rm(root, { recursive: true, force: true })
  })

  test("reports end-turn and disposal sync failures without replacing a successful bash result", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "document-session-sync-failure-"))
    const sessionRoot = path.join(root, "workspace")
    await fs.mkdir(sessionRoot)
    const hydrated = await hydrateSessionDocument({
      sessionId: "session-sync-failure",
      workspaceRoot: sessionRoot,
      documentId: "document-a",
      displayName: "Plan",
      markdown: "before",
      baseVersion: "version-1",
      sync: async () => {
        throw new Error("version conflict")
      },
    })
    const failures = vi.fn()
    const env = await createClaxedoSessionEnvFactory({ fetchOptions, onHydrationFailure: failures })({
      sessionId: "session-sync-failure",
      mode: "hybrid",
      host: "central",
      toolSandbox: { kind: "workspace-runtime", workspaceId: "ws-1" },
    })
    mocks.ensureEmbeddedWorkspaceRuntime.mockResolvedValue({
      app: {
        fetch: async () => {
          await fs.writeFile(hydrated, "preserve this edit")
          return ndjsonResponse([{ type: "exit", exitCode: 0 }])
        },
      },
    })

    await expect(
      sessionEnvBashTool(env).execute(
        "tool-call-document-conflict",
        { command: `printf 'preserve this edit' > '${hydrated}'` },
        new AbortController().signal,
      ),
    ).resolves.toBeDefined()
    expect(failures).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "end-turn",
        sessionId: "session-sync-failure",
        error: expect.objectContaining({ message: "version conflict" }),
      }),
    )
    await expect(env.dispose?.()).resolves.toBeUndefined()
    expect(failures).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "dispose",
        sessionId: "session-sync-failure",
        documentId: "document-a",
        path: hydrated,
        error: expect.objectContaining({ message: "version conflict" }),
      }),
    )
    expect(await fs.readFile(hydrated, "utf8")).toBe("preserve this edit")
    forgetHydratedSessionRuntime("session-sync-failure")
    await fs.rm(root, { recursive: true, force: true })
  })
})

describe("createWorkspaceRuntimeSessionEnv", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test("kind is workspace-runtime and cwd/resolvePath default to root without a directory", () => {
    const env = createWorkspaceRuntimeSessionEnv({ workspace, fetchOptions })
    expect(env.kind).toBe("workspace-runtime")
    expect(env.cwd()).toBe("/")
    expect(env.resolvePath()).toBe("/")
    expect(env.resolvePath("foo/bar")).toBe("/foo/bar")
  })

  test("cwd/resolvePath honor a directory", () => {
    const env = createWorkspaceRuntimeSessionEnv({ workspace, directory: "sub", fetchOptions })
    expect(env.cwd()).toBe("/sub")
    expect(env.resolvePath()).toBe("/sub")
    expect(env.resolvePath("foo")).toBe("/sub/foo")
    expect(env.resolvePath("/abs")).toBe("/abs")
  })

  describe("exec", () => {
    test("folds an NDJSON stream into stdout/stderr/exitCode and invokes onStdout", async () => {
      mockEmbeddedResponse(
        ndjsonResponse([
          { type: "stdout", data: b64("hello ") },
          { type: "stdout", data: b64("world") },
          { type: "stderr", data: b64("warn") },
          { type: "exit", exitCode: 0 },
        ]),
      )
      const env = createWorkspaceRuntimeSessionEnv({ workspace, fetchOptions })
      const seen: string[] = []
      const result = await env.exec("echo hi", { onStdout: (chunk) => seen.push(chunk) })
      expect(result).toEqual({ stdout: "hello world", stderr: "warn", exitCode: 0 })
      expect(seen).toEqual(["hello ", "world"])
    })

    test("reassembles a multi-byte character split across two stdout frames without U+FFFD", async () => {
      // "café☕" — the é (2 bytes) and the ☕ (3 bytes) are each split down the
      // middle across frame boundaries. Independent per-frame decoding would
      // emit U+FFFD; the streaming decoder must carry the partial bytes.
      const bytes = new TextEncoder().encode("café☕")
      // Split points chosen to bisect the é (index 3-4) and the ☕ (index 5-7).
      const frame1 = bytes.slice(0, 4) // "caf" + first byte of é
      const frame2 = bytes.slice(4, 6) // rest of é + first byte of ☕
      const frame3 = bytes.slice(6) // rest of ☕
      mockEmbeddedResponse(
        ndjsonResponse([
          { type: "stdout", data: b64Bytes(frame1) },
          { type: "stdout", data: b64Bytes(frame2) },
          { type: "stdout", data: b64Bytes(frame3) },
          { type: "exit", exitCode: 0 },
        ]),
      )
      const env = createWorkspaceRuntimeSessionEnv({ workspace, fetchOptions })
      const seen: string[] = []
      const result = await env.exec("cat", { onStdout: (chunk) => seen.push(chunk) })
      expect(result.stdout).toBe("café☕")
      expect(result.stdout).not.toContain("�")
      expect(seen.join("")).toBe("café☕")
      for (const chunk of seen) expect(chunk).not.toContain("�")
    })

    test("passes command/cwd/env/timeout in the JSON body and hits /exec", async () => {
      mockEmbeddedResponse(ndjsonResponse([{ type: "exit", exitCode: 0 }]))
      const env = createWorkspaceRuntimeSessionEnv({ workspace, directory: "sub", fetchOptions })
      await env.exec("ls", {
        cwd: "nested",
        env: { FOO: "bar" },
        timeoutMs: 5000,
      })
      const { path, request } = lastEmbeddedCall()
      expect(path).toBe("/api/wr/session-env/exec")
      expect(request.method).toBe("POST")
      expect(JSON.parse(await request.text())).toEqual({
        command: "ls",
        cwd: "sub/nested",
        env: { FOO: "bar" },
        timeout: 5000,
      })
    })

    test("throws when the exit frame reports a timeout", async () => {
      mockEmbeddedResponse(ndjsonResponse([{ type: "exit", exitCode: null, timedOut: true }]))
      const env = createWorkspaceRuntimeSessionEnv({ workspace, fetchOptions })
      await expect(env.exec("sleep 100")).rejects.toThrow("command timed out")
    })

    test("throws when an error frame is emitted", async () => {
      mockEmbeddedResponse(ndjsonResponse([{ type: "error", error: "spawn failed" }]))
      const env = createWorkspaceRuntimeSessionEnv({ workspace, fetchOptions })
      await expect(env.exec("nope")).rejects.toThrow("spawn failed")
    })

    test("rejects malformed frames and cancels the response stream", async () => {
      const cancel = vi.fn()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"type":"stdout","data":"%%%"}\n'))
        },
        cancel,
      })
      mockEmbeddedResponse(new Response(stream, { status: 200 }))
      const env = createWorkspaceRuntimeSessionEnv({ workspace, fetchOptions })

      await expect(env.exec("bad-frame")).rejects.toBeInstanceOf(WorkspaceRuntimeProtocolError)
      expect(cancel).toHaveBeenCalledTimes(1)
    })

    test("cancels the response stream when an output callback throws", async () => {
      const cancel = vi.fn()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "stdout", data: b64("hello") })}\n`))
        },
        cancel,
      })
      mockEmbeddedResponse(new Response(stream, { status: 200 }))
      const env = createWorkspaceRuntimeSessionEnv({ workspace, fetchOptions })

      await expect(
        env.exec("callback", {
          onStdout: () => {
            throw new Error("consumer failed")
          },
        }),
      ).rejects.toThrow("consumer failed")
      expect(cancel).toHaveBeenCalledTimes(1)
    })

    test("cancels and fails with a typed error when output exceeds the byte budget", async () => {
      const cancel = vi.fn()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "stdout", data: b64("too much") })}\n`))
        },
        cancel,
      })
      mockEmbeddedResponse(new Response(stream, { status: 200 }))
      const env = createWorkspaceRuntimeSessionEnv({ workspace, fetchOptions, execOutputLimitBytes: 3 })

      await expect(env.exec("verbose")).rejects.toBeInstanceOf(WorkspaceRuntimeExecLimitError)
      expect(cancel).toHaveBeenCalledTimes(1)
    })

    test("cancels and fails with a typed error when one frame exceeds the frame budget", async () => {
      const cancel = vi.fn()
      const oversized = Buffer.alloc(Math.ceil(SESSION_ENV_EXEC_MAX_FRAME_BYTES * 0.8)).toString("base64")
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "stdout", data: oversized })}\n`))
        },
        cancel,
      })
      mockEmbeddedResponse(new Response(stream, { status: 200 }))
      const env = createWorkspaceRuntimeSessionEnv({ workspace, fetchOptions })

      await expect(env.exec("one-huge-frame")).rejects.toMatchObject({
        name: "WorkspaceRuntimeExecLimitError",
        code: "workspace_runtime_exec_frame_limit",
      })
      expect(cancel).toHaveBeenCalledTimes(1)
    })
  })

  describe("file ops", () => {
    test("readFile decodes base64 content", async () => {
      mockEmbeddedResponse(jsonResponse({ encoding: "base64", content: b64("file body") }))
      const env = createWorkspaceRuntimeSessionEnv({ workspace, fetchOptions })
      const content = await env.readFile("/notes.txt")
      expect(new TextDecoder().decode(content)).toBe("file body")
      expect(lastEmbeddedCall().path).toBe("/api/wr/session-env/file/read?path=notes.txt")
    })

    test.each([
      [
        "readFile",
        () => jsonResponse({}),
        (env: ReturnType<typeof createWorkspaceRuntimeSessionEnv>) => env.readFile("/x"),
      ],
      [
        "readFile base64",
        () => jsonResponse({ encoding: "base64", content: "%%%" }),
        (env: ReturnType<typeof createWorkspaceRuntimeSessionEnv>) => env.readFile("/x"),
      ],
      [
        "stat",
        () => jsonResponse({ isFile: true }),
        (env: ReturnType<typeof createWorkspaceRuntimeSessionEnv>) => env.stat("/x"),
      ],
      [
        "readdir",
        () => jsonResponse(["ok", 3]),
        (env: ReturnType<typeof createWorkspaceRuntimeSessionEnv>) => env.readdir("/"),
      ],
      [
        "exists",
        () => jsonResponse({}),
        (env: ReturnType<typeof createWorkspaceRuntimeSessionEnv>) => env.exists("/x"),
      ],
      [
        "writeFile",
        () => jsonResponse({}),
        (env: ReturnType<typeof createWorkspaceRuntimeSessionEnv>) => env.writeFile("/x", "x"),
      ],
    ])("rejects malformed successful %s responses", async (_name, response, invoke) => {
      mockEmbeddedResponse(response())
      const env = createWorkspaceRuntimeSessionEnv({ workspace, fetchOptions })
      await expect(invoke(env)).rejects.toBeInstanceOf(WorkspaceRuntimeProtocolError)
    })

    test("writeFile posts base64 content with encoding and a workspace-relative path", async () => {
      mockEmbeddedResponse(jsonResponse({ ok: true }))
      const env = createWorkspaceRuntimeSessionEnv({ workspace, directory: "sub", fetchOptions })
      await env.writeFile("out.txt", "payload")
      const { path, request } = lastEmbeddedCall()
      expect(path).toBe("/api/wr/session-env/file/write")
      expect(request.method).toBe("POST")
      expect(JSON.parse(await request.text())).toEqual({
        path: "sub/out.txt",
        content: b64("payload"),
        encoding: "base64",
      })
    })

    test("stat hits the stat path with a relative path", async () => {
      const stat = {
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        size: 4,
        mtimeMs: 1,
      }
      mockEmbeddedResponse(jsonResponse(stat))
      const env = createWorkspaceRuntimeSessionEnv({ workspace, fetchOptions })
      await expect(env.stat("/a/b.txt")).resolves.toEqual(stat)
      expect(lastEmbeddedCall().path).toBe("/api/wr/session-env/file/stat?path=a%2Fb.txt")
    })

    test("readdir hits the readdir path and returns the list", async () => {
      mockEmbeddedResponse(jsonResponse(["a", "b"]))
      const env = createWorkspaceRuntimeSessionEnv({ workspace, fetchOptions })
      await expect(env.readdir("dir")).resolves.toEqual(["a", "b"])
      expect(lastEmbeddedCall().path).toBe("/api/wr/session-env/file/readdir?path=dir")
    })

    test("exists returns the boolean and strips leading slashes", async () => {
      mockEmbeddedResponse(jsonResponse({ exists: true }))
      const env = createWorkspaceRuntimeSessionEnv({ workspace, fetchOptions })
      await expect(env.exists("/present")).resolves.toBe(true)
      expect(lastEmbeddedCall().path).toBe("/api/wr/session-env/file/exists?path=present")
    })

    test("mkdir posts the path and recursive flag", async () => {
      mockEmbeddedResponse(jsonResponse({ ok: true }))
      const env = createWorkspaceRuntimeSessionEnv({ workspace, fetchOptions })
      await env.mkdir("/nested/dir")
      const { path, request } = lastEmbeddedCall()
      expect(path).toBe("/api/wr/session-env/file/mkdir")
      expect(JSON.parse(await request.text())).toEqual({ path: "nested/dir", recursive: true })
    })

    test("rm posts the path with recursive and force flags", async () => {
      mockEmbeddedResponse(jsonResponse({ ok: true }))
      const env = createWorkspaceRuntimeSessionEnv({ workspace, fetchOptions })
      await env.rm("/gone", { recursive: true, force: true })
      const { path, request } = lastEmbeddedCall()
      expect(path).toBe("/api/wr/session-env/file/rm")
      expect(JSON.parse(await request.text())).toEqual({ path: "gone", recursive: true, force: true })
    })
  })

  test("surfaces the server error message on a non-ok response", async () => {
    mockEmbeddedResponse(jsonResponse({ error: { code: "boom", message: "disk full" } }, 500))
    const env = createWorkspaceRuntimeSessionEnv({ workspace, fetchOptions })
    await expect(env.readFile("/x")).rejects.toMatchObject({
      name: "WorkspaceRuntimeRequestError",
      status: 500,
      code: "boom",
      operation: "readFile",
      message: "workspace-runtime readFile failed: disk full",
    })
  })
})

describe("cloud session-env caching", () => {
  let fetchSpy: ReturnType<typeof vi.fn<FetchCall>>

  function ensureReady(overrides?: { hostId?: string; homeRegion?: string }) {
    return {
      status: "ready" as const,
      workspaceId: cloudWorkspace.id,
      sandboxId: "sbx-1",
      url: "http://sandbox.local",
      hostId: overrides?.hostId ?? "host-1",
      homeRegion: overrides?.homeRegion ?? "us-east",
      epoch: 1,
    }
  }

  function cloudOptions() {
    const sandboxManager = {
      ensure: vi.fn(async () => ensureReady()),
      target: vi.fn(async () => ensureReady()),
    } satisfies SandboxManagerPort
    const relayProvider = {
      getRelayEndpoint: vi.fn(async () => "https://relay.example"),
      mintHostTunnelToken: vi.fn(async () => ({
        token: "host-token",
        expiresAt: Date.now() + 10 * 60_000,
        jti: "host-jti",
      })),
      mintRuntimeAccessToken: vi.fn(async () => ({
        token: "tok-1",
        expiresAt: Date.now() + 10 * 60_000,
        jti: "jti-1",
      })),
      resolveTarget: vi.fn(async () => undefined),
      drainWorkspace: vi.fn(async () => {}),
    } satisfies RelayProvider
    const options = {
      sandboxManager,
      relayProvider,
      defaultHomeRegion: "us-east",
      runtimeActor: {
        principalKind: "service",
        actorId: "control-plane",
        actorKind: "agent",
      },
      role: "owner",
    } satisfies SandboxFetchOptions
    return { sandboxManager, relayProvider, options }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    fetchSpy = vi.fn<FetchCall>()
    vi.stubGlobal("fetch", fetchSpy)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test("resolves ensure + mint once across many ops and reuses the relay endpoint", async () => {
    const { sandboxManager, relayProvider, options } = cloudOptions()
    fetchSpy.mockImplementation(async () => jsonResponse({ exists: true }))
    const env = createWorkspaceRuntimeSessionEnv({ workspace: cloudWorkspace, fetchOptions: options })

    await env.exists("a")
    await env.exists("b")
    await env.exists("c")

    expect(sandboxManager.ensure).toHaveBeenCalledTimes(1)
    expect(relayProvider.mintRuntimeAccessToken).toHaveBeenCalledTimes(1)
    expect(relayProvider.getRelayEndpoint).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    const firstUrl = requestUrl(fetchSpy.mock.calls[0][0])
    expect(firstUrl).toBe("https://relay.example/workspaces/ws-cloud/api/wr/session-env/file/exists?path=a")
    const headers = new Headers(fetchSpy.mock.calls[0][1]?.headers)
    expect(headers.get("authorization")).toBe("Bearer tok-1")
  })

  test("rejects an incomplete service principal before creating a cloud requester", () => {
    const { options } = cloudOptions()
    expect(() =>
      createWorkspaceRuntimeSessionEnv({
        workspace: cloudWorkspace,
        fetchOptions: { ...options, role: undefined },
      }),
    ).toThrow("runtime role required for runtime token minting: ws-cloud")
  })

  test("re-mints the token when it is near expiry", async () => {
    const { relayProvider, options } = cloudOptions()
    relayProvider.mintRuntimeAccessToken
      .mockResolvedValueOnce({ token: "tok-1", expiresAt: Date.now() + 1_000, jti: "a" })
      .mockResolvedValueOnce({ token: "tok-2", expiresAt: Date.now() + 10 * 60_000, jti: "b" })
    fetchSpy.mockImplementation(async () => jsonResponse({ exists: true }))
    const env = createWorkspaceRuntimeSessionEnv({ workspace: cloudWorkspace, fetchOptions: options })

    await env.exists("a")
    await env.exists("b")

    expect(relayProvider.mintRuntimeAccessToken).toHaveBeenCalledTimes(2)
    const secondHeaders = new Headers(fetchSpy.mock.calls[1][1]?.headers)
    expect(secondHeaders.get("authorization")).toBe("Bearer tok-2")
  })

  test("re-ensures and retries once on a 502 response", async () => {
    const { sandboxManager, options } = cloudOptions()
    sandboxManager.ensure
      .mockResolvedValueOnce(ensureReady({ hostId: "host-1" }))
      .mockResolvedValueOnce(ensureReady({ hostId: "host-2" }))
    fetchSpy
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
      .mockResolvedValueOnce(jsonResponse({ exists: true }))
    const env = createWorkspaceRuntimeSessionEnv({ workspace: cloudWorkspace, fetchOptions: options })

    const result = await env.exists("a")

    expect(result).toBe(true)
    expect(sandboxManager.ensure).toHaveBeenCalledTimes(2)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  test("does not retry a state-changing exec after a 502 response", async () => {
    const { sandboxManager, options } = cloudOptions()
    fetchSpy.mockResolvedValue(new Response("bad gateway", { status: 502 }))
    const env = createWorkspaceRuntimeSessionEnv({ workspace: cloudWorkspace, fetchOptions: options })

    await expect(env.exec("touch once")).rejects.toBeInstanceOf(WorkspaceRuntimeRequestError)
    expect(sandboxManager.ensure).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test("does not retry a state-changing exec after a connectivity failure", async () => {
    const { sandboxManager, options } = cloudOptions()
    fetchSpy.mockRejectedValue(new TypeError("connection reset"))
    const env = createWorkspaceRuntimeSessionEnv({ workspace: cloudWorkspace, fetchOptions: options })

    await expect(env.exec("touch once")).rejects.toThrow("connection reset")
    expect(sandboxManager.ensure).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test("does not re-ensure when the initial request succeeds", async () => {
    const { sandboxManager, options } = cloudOptions()
    fetchSpy.mockImplementation(async () => jsonResponse({ exists: true }))
    const env = createWorkspaceRuntimeSessionEnv({ workspace: cloudWorkspace, fetchOptions: options })

    await env.exists("a")

    expect(sandboxManager.ensure).toHaveBeenCalledTimes(1)
  })
})

describe("prepareWorkspaceRuntimeSession", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  test("creates the worktree through one exact runtime generation and returns its epoch", async () => {
    const sandboxManager = {
      ensure: vi.fn(async () => ({
        status: "ready" as const,
        workspaceId: cloudWorkspace.id,
        sandboxId: "sbx-7",
        url: "http://sandbox.local",
        hostId: "host-7",
        homeRegion: "us-east",
        epoch: 7,
      })),
      target: vi.fn(async () => ({
        status: "ready" as const,
        workspaceId: cloudWorkspace.id,
        sandboxId: "sbx-7",
        url: "http://sandbox.local",
        hostId: "host-7",
        homeRegion: "us-east",
        epoch: 7,
      })),
    } satisfies SandboxManagerPort
    const relayProvider = {
      getRelayEndpoint: vi.fn(async () => "https://relay.example"),
      mintHostTunnelToken: vi.fn(async () => ({
        token: "host-token",
        expiresAt: Date.now() + 10 * 60_000,
        jti: "host-jti",
      })),
      mintRuntimeAccessToken: vi.fn(async () => ({
        token: "tok-7",
        expiresAt: Date.now() + 10 * 60_000,
        jti: "jti-7",
      })),
      resolveTarget: vi.fn(async () => undefined),
      drainWorkspace: vi.fn(async () => {}),
    } satisfies RelayProvider
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchCall>(async () =>
        jsonResponse(
          {
            worktree: { path: "/worktrees/s-1", branch: "claxedo/session/s-1", baseCommit: "abc" },
          },
          201,
        ),
      ),
    )

    await expect(
      prepareWorkspaceRuntimeSession({
        workspace: cloudWorkspace,
        sessionId: "s-1",
        fetchOptions: {
          sandboxManager,
          relayProvider,
          runtimeActor: { principalKind: "service", actorId: "control-plane", actorKind: "agent" },
          role: "owner",
        },
      }),
    ).resolves.toEqual({
      directory: "/worktrees/s-1",
      worktree: "claxedo/session/s-1",
      baseCommit: "abc",
      leaseEpoch: 7,
    })
    expect(sandboxManager.ensure).toHaveBeenCalledTimes(1)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })
})
