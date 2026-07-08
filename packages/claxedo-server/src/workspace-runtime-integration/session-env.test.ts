import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  ensureEmbeddedWorkspaceRuntime: vi.fn(),
  resolveWorkspace: vi.fn(),
  embeddedFetch: vi.fn(),
}))

vi.mock("../embedded-workspace-runtime", () => ({
  ensureEmbeddedWorkspaceRuntime: mocks.ensureEmbeddedWorkspaceRuntime,
}))

vi.mock("../workspace-store", () => ({
  resolveWorkspace: mocks.resolveWorkspace,
}))

import type { SandboxFetchOptions } from "../sandbox-target-fetch"
import { createClaxedoSessionEnvFactory, createWorkspaceRuntimeSessionEnv } from "./session-env"
import type { Workspace } from "../workspace-store"

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
  const body = frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n"
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

/** Grabs the requestPath (1st arg to app.fetch's Request) + init from the last embedded fetch. */
function lastEmbeddedCall() {
  const call = mocks.embeddedFetch.mock.calls.at(-1)!
  const request = call[0] as Request
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
  })

  describe("file ops", () => {
    test("readFile decodes base64 content", async () => {
      mockEmbeddedResponse(jsonResponse({ content: b64("file body") }))
      const env = createWorkspaceRuntimeSessionEnv({ workspace, fetchOptions })
      const content = await env.readFile("/notes.txt")
      expect(new TextDecoder().decode(content)).toBe("file body")
      expect(lastEmbeddedCall().path).toBe("/api/wr/session-env/file/read?path=notes.txt")
    })

    test("writeFile posts base64 content with encoding and a workspace-relative path", async () => {
      mockEmbeddedResponse(jsonResponse({}))
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
      mockEmbeddedResponse(jsonResponse({}))
      const env = createWorkspaceRuntimeSessionEnv({ workspace, fetchOptions })
      await env.mkdir("/nested/dir")
      const { path, request } = lastEmbeddedCall()
      expect(path).toBe("/api/wr/session-env/file/mkdir")
      expect(JSON.parse(await request.text())).toEqual({ path: "nested/dir", recursive: true })
    })

    test("rm posts the path with recursive and force flags", async () => {
      mockEmbeddedResponse(jsonResponse({}))
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
    await expect(env.readFile("/x")).rejects.toThrow("session-env readFile failed: disk full")
  })
})

describe("cloud session-env caching", () => {
  const originalFetch = globalThis.fetch
  let fetchSpy: ReturnType<typeof vi.fn>

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
    const sandboxManager = { ensure: vi.fn(async () => ensureReady()) }
    const relayProvider = {
      getRelayEndpoint: vi.fn(async () => "https://relay.example"),
      mintRuntimeAccessToken: vi.fn(async () => ({
        token: "tok-1",
        expiresAt: Date.now() + 10 * 60_000,
        jti: "jti-1",
      })),
    }
    const options = {
      sandboxManager,
      relayProvider,
      defaultHomeRegion: "us-east",
    } as unknown as SandboxFetchOptions
    return { sandboxManager, relayProvider, options }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
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
    const firstUrl = fetchSpy.mock.calls[0][0] as string
    expect(firstUrl).toBe("https://relay.example/workspaces/ws-cloud/api/wr/session-env/file/exists?path=a")
    const headers = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Headers
    expect(headers.get("authorization")).toBe("Bearer tok-1")
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
    const secondHeaders = (fetchSpy.mock.calls[1][1] as RequestInit).headers as Headers
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

  test("does not re-ensure when the initial request succeeds", async () => {
    const { sandboxManager, options } = cloudOptions()
    fetchSpy.mockImplementation(async () => jsonResponse({ exists: true }))
    const env = createWorkspaceRuntimeSessionEnv({ workspace: cloudWorkspace, fetchOptions: options })

    await env.exists("a")

    expect(sandboxManager.ensure).toHaveBeenCalledTimes(1)
  })
})
