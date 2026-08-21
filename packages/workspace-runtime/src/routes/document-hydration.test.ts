import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fetchDouble } from "../test-support/fetch-double"
import { Hono } from "hono"
import { afterEach, describe, expect, test, mock, spyOn } from "bun:test"
import {
  disposeRuntimeSessionDocuments,
  flushRuntimeDocument,
  forgetRuntimeDocuments,
  RuntimeDocumentHydrationRoutes,
} from "./document-hydration"
import { LocalDocumentBrokerRoutes } from "./local-document-broker"

describe("runtime document hydration", () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    forgetRuntimeDocuments()
    globalThis.fetch = originalFetch
  })

  test("rejects declared and chunked oversized hydration bodies before JSON parsing", async () => {
    const app = new Hono().route("/", RuntimeDocumentHydrationRoutes({ trustedTransport: true }))
    expect(
      (
        await app.request("/api/wr/documents/hydrate", {
          method: "POST",
          headers: { "content-length": String(2 * 1024 * 1024 + 1) },
          body: "{}",
        })
      ).status,
    ).toBe(413)
    const chunk = new Uint8Array(1024 * 1024)
    const response = await app.fetch(
      new Request("http://runtime.test/api/wr/documents/hydrate", {
        method: "POST",
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(chunk)
            controller.enqueue(chunk)
            controller.enqueue(new Uint8Array([1]))
            controller.close()
          },
        }),
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    )
    expect(response.status).toBe(413)
  })

  test("rejects declared and chunked oversized local-broker bodies before verification", async () => {
    const app = new Hono().route("/", LocalDocumentBrokerRoutes({ trustedTransport: true }))
    expect(
      (
        await app.request("/api/wr/local-documents/broker", {
          method: "POST",
          headers: { "content-length": String(2 * 1024 * 1024 + 1) },
          body: "{}",
        })
      ).status,
    ).toBe(413)
    const chunk = new Uint8Array(1024 * 1024)
    const response = await app.fetch(
      new Request("http://runtime.test/api/wr/local-documents/broker", {
        method: "POST",
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(chunk)
            controller.enqueue(chunk)
            controller.enqueue(new Uint8Array([1]))
            controller.close()
          },
        }),
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    )
    expect(response.status).toBe(413)
  })

  test("returns stable validation errors for malformed hydration, resolution, and broker bodies", async () => {
    const hydration = new Hono().route("/", RuntimeDocumentHydrationRoutes({ trustedTransport: true }))
    const broker = new Hono().route("/", LocalDocumentBrokerRoutes({ trustedTransport: true }))

    for (const response of [
      await hydration.request("/api/wr/documents/hydrate", { method: "POST", body: "{" }),
      await hydration.request("/api/wr/documents/hydrate", { method: "POST", body: "{}" }),
      await hydration.request("/api/wr/documents/session_1/document_1/resolve", { method: "POST", body: "{" }),
      await broker.request("/api/wr/local-documents/broker", { method: "POST", body: "{" }),
      await broker.request("/api/wr/local-documents/broker", { method: "POST", body: "{}" }),
    ]) {
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({ error: "document_request_invalid" })
    }
  })

  test("returns a stable forbidden response for rejected broker capabilities", async () => {
    const app = new Hono().route("/", LocalDocumentBrokerRoutes({ trustedTransport: true }))
    const response = await app.request("/api/wr/local-documents/broker", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-claxedo-document-capability": "not-a-document-job-token",
      },
      body: JSON.stringify({
        userId: "user_1",
        orgId: "org_1",
        projectId: "project_1",
        localWorkspaceId: "local_1",
        cloudWorkspaceId: "cloud_1",
        sessionId: "session_1",
        documentId: "document_1",
        operation: "read",
      }),
    })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: "document_broker_capability_invalid" })
  })

  test("returns a stable forbidden response when conflict resolution capability verification fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-document-resolve-capability-"))
    globalThis.fetch = fetchDouble(mock(async () => new Response("conflict", { status: 409 })))
    const app = new Hono().route(
      "/",
      RuntimeDocumentHydrationRoutes({
        workspaceRoot: root,
        trustedTransport: true,
        controlPlaneOrigin: "https://control.test",
        verifyJob: async (token) => {
          if (token === "hydrate-job") return {}
          throw new Error("expired capability")
        },
      }),
    )
    const hydrated = await (await app.request("/api/wr/documents/hydrate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: "session_resolve",
          documentId: "document_resolve",
          displayName: "Plan",
          markdown: "durable",
          baseVersion: "v1",
          job: {
            token: "hydrate-job",
            userId: "user_1",
            orgId: "org_1",
            projectId: "project_1",
            localWorkspaceId: "local_1",
            cloudWorkspaceId: "cloud_1",
          },
          writeback: {
            url: "https://control.test/write",
            renewUrl: "https://control.test/renew",
            token: "write-token",
            expiresAt: Date.now() + 300_000,
          },
        }),
      })).json() as { path: string }
    await activateRuntimeDocument(app, "session_resolve", "document_resolve")
    await fs.writeFile(hydrated.path, "session draft")
    await expect(flushRuntimeDocument("session_resolve", "document_resolve")).rejects.toThrow("conflicted")

    const response = await app.request("/api/wr/documents/session_resolve/document_resolve/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        strategy: "keep-session",
        remoteVersion: "v2",
        job: {
          token: "expired-job",
          userId: "user_1",
          orgId: "org_1",
          projectId: "project_1",
          localWorkspaceId: "local_1",
          cloudWorkspaceId: "cloud_1",
        },
        writeback: {
          url: "https://control.test/write",
          renewUrl: "https://control.test/renew",
          token: "fresh-token",
          expiresAt: Date.now() + 300_000,
        },
      }),
    })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: "document_resolution_capability_invalid" })
    await fs.rm(root, { recursive: true, force: true })
  })

  test("materializes one scoped document and retains the capability outside the file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-document-"))
    const fetcher = mock(async () => Response.json({ version: "v2" }))
    globalThis.fetch = fetchDouble(fetcher)
    const app = new Hono().route(
      "/",
      RuntimeDocumentHydrationRoutes({
        workspaceRoot: root,
        trustedTransport: true,
        controlPlaneOrigin: "https://control.test",
        verifyJob: async () => ({}),
      }),
    )
    const response = await app.request("/api/wr/documents/hydrate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "session_1",
        documentId: "document_1",
        displayName: "Plan",
        markdown: "before",
        baseVersion: "v1",
        job: {
          token: "job-token",
          userId: "user_1",
          orgId: "org_1",
          projectId: "project_1",
          localWorkspaceId: "ws_1",
          cloudWorkspaceId: "ws_1",
        },
        writeback: {
          url: "https://control.test/documents/document_1/runtime-writeback",
          renewUrl: "https://control.test/documents/document_1/runtime-capability/renew",
          token: "secret-token",
          expiresAt: Date.now() + 300_000,
        },
      }),
    })
    const opened = (await response.json()) as { path: string }
    await activateRuntimeDocument(app, "session_1", "document_1")
    expect(await fs.readFile(opened.path, "utf8")).toBe("before")
    expect(
      await fs.readFile(path.join(root, ".claxedo", "sessions", "session_1", "docs", "manifest.json"), "utf8"),
    ).not.toContain("secret-token")
    expect(
      await fs.stat(path.join(root, ".claxedo", "sessions", "session_1", "docs", "document_2")).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
    await fs.writeFile(opened.path, "agent edit")
    await flushRuntimeDocument("session_1", "document_1")
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("document_1/runtime-writeback"),
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer secret-token", "if-match": "v1" }),
      }),
    )
    await fs.rm(root, { recursive: true, force: true })
  })

  test("parks the session copy when the conditional callback conflicts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-document-conflict-"))
    globalThis.fetch = fetchDouble(mock(async () => new Response("conflict", { status: 409 })))
    const app = new Hono().route(
      "/",
      RuntimeDocumentHydrationRoutes({
        workspaceRoot: root,
        trustedTransport: true,
        controlPlaneOrigin: "https://control.test",
        verifyJob: async () => ({}),
      }),
    )
    const response = await app.request("/api/wr/documents/hydrate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "session_1",
        documentId: "document_1",
        displayName: "Plan",
        markdown: "durable",
        baseVersion: "v1",
        job: {
          token: "job-token",
          userId: "user_1",
          orgId: "org_1",
          projectId: "project_1",
          localWorkspaceId: "ws_1",
          cloudWorkspaceId: "ws_1",
        },
        writeback: {
          url: "https://control.test/write",
          renewUrl: "https://control.test/renew",
          token: "secret-token",
          expiresAt: Date.now() + 300_000,
        },
      }),
    })
    const opened = (await response.json()) as { path: string }
    await activateRuntimeDocument(app, "session_1", "document_1")
    await fs.writeFile(opened.path, "session draft")
    await expect(flushRuntimeDocument("session_1", "document_1")).rejects.toThrow("conflicted")
    expect(await fs.readFile(opened.path, "utf8")).toBe("session draft")
    expect(
      JSON.parse(
        await fs.readFile(path.join(root, ".claxedo", "sessions", "session_1", "docs", "manifest.json"), "utf8"),
      ),
    ).toMatchObject({ documents: [{ state: "conflicted" }] })
    await fs.rm(root, { recursive: true, force: true })
  })

  test("disposal releases and forgets conflicted documents while preserving their recovery files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-document-dispose-conflict-"))
    const timer = renewalTimer(1_000_000)
    const methods: string[] = []
    globalThis.fetch = fetchDouble(mock(async (_input: string | URL | Request, init?: RequestInit) => {
      methods.push(init?.method ?? "GET")
      return init?.method === "DELETE" ? new Response(null, { status: 204 }) : new Response("conflict", { status: 409 })
    }))
    const app = new Hono().route(
      "/",
      RuntimeDocumentHydrationRoutes({
        workspaceRoot: root,
        trustedTransport: true,
        controlPlaneOrigin: "https://control.test",
        verifyJob: async () => ({}),
        renewalTimer: timer,
      }),
    )
    const hydrated = await (await app.request("/api/wr/documents/hydrate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: "session_dispose_conflict",
          documentId: "document_dispose_conflict",
          displayName: "Plan",
          markdown: "durable",
          baseVersion: "v1",
          job: {
            token: "job",
            userId: "user_1",
            orgId: "org_1",
            projectId: "project_1",
            localWorkspaceId: "local_1",
            cloudWorkspaceId: "cloud_1",
          },
          writeback: {
            url: "https://control.test/write",
            renewUrl: "https://control.test/renew",
            token: "write",
            expiresAt: timer.now() + 300_000,
          },
        }),
      })).json() as { path: string }
    await activateRuntimeDocument(app, "session_dispose_conflict", "document_dispose_conflict")
    await fs.writeFile(hydrated.path, "preserved conflict draft")
    await expect(flushRuntimeDocument("session_dispose_conflict", "document_dispose_conflict")).rejects.toThrow(
      "conflicted",
    )

    await expect(disposeRuntimeSessionDocuments("session_dispose_conflict")).rejects.toThrow(
      "Runtime document disposal failed",
    )
    expect(methods).toEqual(["PUT", "DELETE"])
    expect(timer.cleared(0)).toBe(true)
    await expect(flushRuntimeDocument("session_dispose_conflict", "document_dispose_conflict")).rejects.toThrow(
      "not hydrated",
    )
    expect(await fs.readFile(hydrated.path, "utf8")).toBe("preserved conflict draft")
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(root, ".claxedo", "sessions", "session_dispose_conflict", "docs", "manifest.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ documents: [{ state: "conflicted" }] })
    await fs.rm(root, { recursive: true, force: true })
  })

  test("request deadlines leave the sync tail retryable and keep disposal bounded", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-document-request-timeout-"))
    let request = 0
    globalThis.fetch = fetchDouble(mock(async () => {
      request++
      if (request === 2) return Response.json({ version: "v2" })
      return await new Promise<Response>(() => undefined)
    }))
    const app = new Hono().route(
      "/",
      RuntimeDocumentHydrationRoutes({
        workspaceRoot: root,
        trustedTransport: true,
        controlPlaneOrigin: "https://control.test",
        verifyJob: async () => ({}),
        requestTimeoutMs: 10,
      }),
    )
    const hydrated = await (await app.request("/api/wr/documents/hydrate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: "session_timeout",
          documentId: "document_timeout",
          displayName: "Plan",
          markdown: "before",
          baseVersion: "v1",
          job: {
            token: "job",
            userId: "user_1",
            orgId: "org_1",
            projectId: "project_1",
            localWorkspaceId: "local_1",
            cloudWorkspaceId: "cloud_1",
          },
          writeback: {
            url: "https://control.test/write",
            renewUrl: "https://control.test/renew",
            token: "write",
            expiresAt: Date.now() + 300_000,
          },
        }),
      })).json() as { path: string }
    await activateRuntimeDocument(app, "session_timeout", "document_timeout")
    await fs.writeFile(hydrated.path, "retry after timeout")

    await expect(flushRuntimeDocument("session_timeout", "document_timeout")).rejects.toThrow("timed out")
    await expect(flushRuntimeDocument("session_timeout", "document_timeout")).resolves.toBeUndefined()
    const started = Date.now()
    await expect(disposeRuntimeSessionDocuments("session_timeout")).rejects.toThrow("disposal failed")
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(request).toBe(3)
    await expect(flushRuntimeDocument("session_timeout", "document_timeout")).rejects.toThrow("not hydrated")
    expect(await fs.readFile(hydrated.path, "utf8")).toBe("retry after timeout")
    await fs.rm(root, { recursive: true, force: true })
  })

  test.each(["stalled", "declared oversized", "chunked oversized"] as const)(
    "bounds a %s write-back response and leaves the sync tail retryable",
    async (failure) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-document-response-bound-"))
      const fetcher = mock(async () => {
        if (fetcher.mock.calls.length === 1) return callbackResponse(failure, { version: "ignored" })
        return Response.json({ version: "v2" })
      })
      globalThis.fetch = fetchDouble(fetcher)
      const app = new Hono().route(
        "/",
        RuntimeDocumentHydrationRoutes({
          workspaceRoot: root,
          trustedTransport: true,
          controlPlaneOrigin: "https://control.test",
          verifyJob: async () => ({}),
          requestTimeoutMs: 10,
        }),
      )

      try {
        const hydrated = await (await app.request("/api/wr/documents/hydrate", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(hydrationBody("session_response_bound", "document_response_bound")),
          })).json() as { path: string }
        await activateRuntimeDocument(app, "session_response_bound", "document_response_bound")
        await fs.writeFile(hydrated.path, "retry after bounded response failure")

        await expect(flushRuntimeDocument("session_response_bound", "document_response_bound")).rejects.toThrow(
          failure === "stalled" ? "timed out" : "too large",
        )
        await expect(flushRuntimeDocument("session_response_bound", "document_response_bound")).resolves.toBeUndefined()
        expect(fetcher).toHaveBeenCalledTimes(2)
      } finally {
        await fs.rm(root, { recursive: true, force: true })
      }
    },
  )

  test("serializes replacement hydration behind disposal and keeps the replacement registered", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-document-dispose-race-"))
    const releaseEntered = deferred<void>()
    const releaseCleanup = deferred<void>()
    const timer = renewalTimer(1_000_000)
    globalThis.fetch = fetchDouble(mock(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        releaseEntered.resolve()
        await releaseCleanup.promise
        return new Response(null, { status: 204 })
      }
      return Response.json({ version: "v3" })
    }))
    const app = new Hono().route(
      "/",
      RuntimeDocumentHydrationRoutes({
        workspaceRoot: root,
        trustedTransport: true,
        controlPlaneOrigin: "https://control.test",
        verifyJob: async () => ({}),
        renewalTimer: timer,
      }),
    )
    const body = {
      sessionId: "session_race",
      documentId: "document_race",
      displayName: "Old",
      markdown: "old",
      baseVersion: "v1",
      job: {
        token: "job",
        userId: "user_1",
        orgId: "org_1",
        projectId: "project_1",
        localWorkspaceId: "local_1",
        cloudWorkspaceId: "cloud_1",
      },
      writeback: {
        url: "https://control.test/documents/document_race/runtime-writeback",
        renewUrl: "https://control.test/documents/document_race/runtime-capability/renew",
        token: "write",
        expiresAt: timer.now() + 300_000,
      },
    }
    try {
      await app.request("/api/wr/documents/hydrate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      await activateRuntimeDocument(app, "session_race", "document_race")
      const disposing = disposeRuntimeSessionDocuments("session_race")
      await releaseEntered.promise
      const replacing = app.request("/api/wr/documents/hydrate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, displayName: "Replacement", markdown: "replacement", baseVersion: "v2" }),
      })

      const replacementPath = path.join(
        root,
        ".claxedo",
        "sessions",
        "session_race",
        "docs",
        "document_race",
        "replacement.md",
      )
      for (let attempt = 0; attempt < 200 && !(await exists(replacementPath)); attempt++) await Bun.sleep(1)
      releaseCleanup.resolve()
      const [replacement] = await Promise.all([
        // `app.request` is typed `Response | Promise<Response>`; this one is
        // held pending rather than awaited inline, so normalize before .then.
        Promise.resolve(replacing).then((response) => response.json() as Promise<{ path: string }>),
        disposing,
      ])
      await activateRuntimeDocument(app, "session_race", "document_race")

      expect(await fs.readFile(replacement.path, "utf8")).toBe("replacement")
      await fs.writeFile(replacement.path, "replacement edit")
      await expect(flushRuntimeDocument("session_race", "document_race")).resolves.toBeUndefined()
      expect(timer.cleared(0)).toBe(true)
      expect(timer.cleared(1)).toBe(false)
      expect(
        JSON.parse(
          await fs.readFile(path.join(root, ".claxedo", "sessions", "session_race", "docs", "manifest.json"), "utf8"),
        ),
      ).toMatchObject({ documents: [{ documentId: "document_race", path: replacement.path, state: "active" }] })
    } finally {
      releaseCleanup.resolve()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("waits for an admitted hydration before disposing the runtime session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-document-admission-race-"))
    const writeEntered = deferred<void>()
    const releaseWrite = deferred<void>()
    globalThis.fetch = fetchDouble(mock(async () => new Response(null, { status: 204 })))
    const app = new Hono().route(
      "/",
      RuntimeDocumentHydrationRoutes({
        workspaceRoot: root,
        trustedTransport: true,
        controlPlaneOrigin: "https://control.test",
        verifyJob: async () => ({}),
        beforeWriteOpen: async () => {
          writeEntered.resolve()
          await releaseWrite.promise
        },
      }),
    )
    try {
      const hydrating = app.request("/api/wr/documents/hydrate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(hydrationBody("session_admission", "document_admission")),
      })
      await writeEntered.promise
      const disposing = disposeRuntimeSessionDocuments("session_admission")
      let disposalSettled = false
      void disposing.then(() => {
        disposalSettled = true
      })
      await new Promise((resolve) => setImmediate(resolve))
      expect(disposalSettled).toBe(false)

      releaseWrite.resolve()
      const [response] = await Promise.all([hydrating, disposing])
      expect(response.status).toBe(200)
      await expect(flushRuntimeDocument("session_admission", "document_admission")).rejects.toThrow("not hydrated")
    } finally {
      releaseWrite.resolve()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("rejects a manual flush queued while runtime session disposal is releasing the document", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-document-flush-dispose-race-"))
    const releaseEntered = deferred<void>()
    const releaseCleanup = deferred<void>()
    const methods: string[] = []
    globalThis.fetch = fetchDouble(mock(async (_input: string | URL | Request, init?: RequestInit) => {
      methods.push(init?.method ?? "GET")
      if (init?.method === "DELETE") {
        releaseEntered.resolve()
        await releaseCleanup.promise
        return new Response(null, { status: 204 })
      }
      return Response.json({ version: "v2" })
    }))
    const app = new Hono().route(
      "/",
      RuntimeDocumentHydrationRoutes({
        workspaceRoot: root,
        trustedTransport: true,
        controlPlaneOrigin: "https://control.test",
        verifyJob: async () => ({}),
      }),
    )
    try {
      const hydrated = await (await app.request("/api/wr/documents/hydrate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(hydrationBody("session_flush_dispose", "document_flush_dispose")),
        })).json() as { path: string }
      await activateRuntimeDocument(app, "session_flush_dispose", "document_flush_dispose")
      const disposing = disposeRuntimeSessionDocuments("session_flush_dispose")
      await releaseEntered.promise
      await fs.writeFile(hydrated.path, "late manual edit")
      const flushing = flushRuntimeDocument("session_flush_dispose", "document_flush_dispose")
      await new Promise((resolve) => setImmediate(resolve))
      expect(methods).toEqual(["DELETE"])

      releaseCleanup.resolve()
      await disposing
      await expect(flushing).rejects.toThrow("not hydrated")
      expect(methods).toEqual(["DELETE"])
    } finally {
      releaseCleanup.resolve()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("drops watcher syncs queued while runtime session disposal is releasing the document", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-document-watcher-dispose-race-"))
    const releaseEntered = deferred<void>()
    const releaseCleanup = deferred<void>()
    const methods: string[] = []
    let watcher: import("node:fs").FSWatcher | undefined
    globalThis.fetch = fetchDouble(mock(async (_input: string | URL | Request, init?: RequestInit) => {
      methods.push(init?.method ?? "GET")
      if (init?.method === "DELETE") {
        releaseEntered.resolve()
        await releaseCleanup.promise
        return new Response(null, { status: 204 })
      }
      return Response.json({ version: "v2" })
    }))
    const app = new Hono().route(
      "/",
      RuntimeDocumentHydrationRoutes({
        workspaceRoot: root,
        trustedTransport: true,
        controlPlaneOrigin: "https://control.test",
        verifyJob: async () => ({}),
        afterWatcherCreated: (value) => {
          watcher = value
        },
      }),
    )
    try {
      const hydrated = await (await app.request("/api/wr/documents/hydrate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(hydrationBody("session_watcher_dispose", "document_watcher_dispose")),
        })).json() as { path: string }
      await activateRuntimeDocument(app, "session_watcher_dispose", "document_watcher_dispose")
      const disposing = disposeRuntimeSessionDocuments("session_watcher_dispose")
      await releaseEntered.promise
      await fs.writeFile(hydrated.path, "late watcher edit")
      watcher?.emit("change", "change", path.basename(hydrated.path))
      await Bun.sleep(150)
      expect(methods).toEqual(["DELETE"])

      releaseCleanup.resolve()
      await disposing
      await Bun.sleep(1)
      expect(methods).toEqual(["DELETE"])
    } finally {
      releaseCleanup.resolve()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("retries a transient write-back failure without un-parking conflicts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-document-retry-"))
    const statuses = [503, 200]
    const fetcher = mock(async () => {
      const status = statuses.shift() ?? 409
      return status === 200 ? Response.json({ version: "v2" }) : new Response("failed", { status })
    })
    globalThis.fetch = fetchDouble(fetcher)
    const app = new Hono().route(
      "/",
      RuntimeDocumentHydrationRoutes({
        workspaceRoot: root,
        trustedTransport: true,
        controlPlaneOrigin: "https://control.test",
        verifyJob: async () => ({}),
      }),
    )
    const hydrated = await (await app.request("/api/wr/documents/hydrate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: "session_retry",
          documentId: "document_retry",
          displayName: "Plan",
          markdown: "before",
          baseVersion: "v1",
          job: {
            token: "job",
            userId: "user_1",
            orgId: "org_1",
            projectId: "project_1",
            localWorkspaceId: "local_1",
            cloudWorkspaceId: "cloud_1",
          },
          writeback: {
            url: "https://control.test/write",
            renewUrl: "https://control.test/renew",
            token: "write",
            expiresAt: Date.now() + 300_000,
          },
        }),
      })).json() as { path: string }
    await activateRuntimeDocument(app, "session_retry", "document_retry")
    await fs.writeFile(hydrated.path, "retry me")

    await expect(flushRuntimeDocument("session_retry", "document_retry")).rejects.toThrow("503")
    await expect(flushRuntimeDocument("session_retry", "document_retry")).resolves.toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(2)

    await fs.writeFile(hydrated.path, "now conflict")
    await expect(flushRuntimeDocument("session_retry", "document_retry")).rejects.toThrow("conflicted")
    await expect(flushRuntimeDocument("session_retry", "document_retry")).rejects.toThrow("conflicted")
    expect(fetcher).toHaveBeenCalledTimes(3)
    await fs.rm(root, { recursive: true, force: true })
  })

  test("renews the write-back capability before expiry and schedules the rotated token", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-document-renew-"))
    const timer = renewalTimer(1_000_000)
    const authorizations: string[] = []
    globalThis.fetch = fetchDouble(mock(async (input: string | URL | Request, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "")
      if (String(input).endsWith("/renew")) {
        return Response.json({ token: "rotated-token", expiresAt: timer.now() + 300_000 })
      }
      return Response.json({ version: "v2" })
    }))
    const app = new Hono().route(
      "/",
      RuntimeDocumentHydrationRoutes({
        workspaceRoot: root,
        trustedTransport: true,
        controlPlaneOrigin: "https://control.test",
        verifyJob: async () => ({}),
        renewalTimer: timer,
      }),
    )
    const hydrated = await (await app.request("/api/wr/documents/hydrate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: "session_renew",
          documentId: "document_renew",
          displayName: "Plan",
          markdown: "before",
          baseVersion: "v1",
          job: {
            token: "job",
            userId: "user_1",
            orgId: "org_1",
            projectId: "project_1",
            localWorkspaceId: "local_1",
            cloudWorkspaceId: "cloud_1",
          },
          writeback: {
            url: "https://control.test/write",
            renewUrl: "https://control.test/renew",
            token: "initial-token",
            expiresAt: timer.now() + 120_000,
          },
        }),
      })).json() as { path: string }
    await activateRuntimeDocument(app, "session_renew", "document_renew")

    expect(timer.delays()).toEqual([60_000])
    timer.run(0)
    await waitFor(() => timer.delays().length === 2)
    expect(timer.delays()).toEqual([60_000, 240_000])
    await fs.writeFile(hydrated.path, "after renewal")
    await flushRuntimeDocument("session_renew", "document_renew")
    expect(authorizations).toEqual(["Bearer initial-token", "Bearer rotated-token"])
    await fs.rm(root, { recursive: true, force: true })
  })

  test.each([
    "server error",
    "malformed response",
    "timeout",
    "stalled response",
    "declared oversized response",
    "chunked oversized response",
  ] as const)(
    "parks a draft when capability renewal fails with a %s",
    async (failure) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-document-renew-failure-"))
      const timer = renewalTimer(1_000_000)
      const fetcher = mock(async () => {
        if (failure === "server error") return new Response("failed", { status: 503 })
        if (failure === "malformed response") return Response.json({ token: 42, expiresAt: "later" })
        if (failure === "stalled response") return callbackResponse("stalled", { token: "ignored" })
        if (failure === "declared oversized response")
          return callbackResponse("declared oversized", { token: "ignored" })
        if (failure === "chunked oversized response")
          return callbackResponse("chunked oversized", { token: "ignored" })
        return await new Promise<Response>(() => undefined)
      })
      globalThis.fetch = fetchDouble(fetcher)
      const error = spyOn(console, "error").mockImplementation(() => {})
      const app = new Hono().route(
        "/",
        RuntimeDocumentHydrationRoutes({
          workspaceRoot: root,
          trustedTransport: true,
          controlPlaneOrigin: "https://control.test",
          verifyJob: async () => ({}),
          renewalTimer: timer,
          requestTimeoutMs: 10,
        }),
      )

      try {
        const hydrated = await (await app.request("/api/wr/documents/hydrate", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              sessionId: "session_failed_renew",
              documentId: "document_failed_renew",
              displayName: "Plan",
              markdown: "before",
              baseVersion: "v1",
              job: {
                token: "job",
                userId: "user_1",
                orgId: "org_1",
                projectId: "project_1",
                localWorkspaceId: "local_1",
                cloudWorkspaceId: "cloud_1",
              },
              writeback: {
                url: "https://control.test/write",
                renewUrl: "https://control.test/renew",
                token: "stale-token",
                expiresAt: timer.now() + 120_000,
              },
            }),
          })).json() as { path: string }
        await activateRuntimeDocument(app, "session_failed_renew", "document_failed_renew")
        await fs.writeFile(hydrated.path, "preserved draft")
        timer.run(0)
        const manifest = path.join(root, ".claxedo", "sessions", "session_failed_renew", "docs", "manifest.json")
        await waitFor(async () => JSON.parse(await fs.readFile(manifest, "utf8")).documents[0].state === "conflicted")

        expect(await fs.readFile(hydrated.path, "utf8")).toBe("preserved draft")
        await expect(flushRuntimeDocument("session_failed_renew", "document_failed_renew")).rejects.toThrow(
          "conflicted",
        )
        expect(fetcher).toHaveBeenCalledTimes(1)
        expect(error).toHaveBeenCalledWith("[runtime-document] capability renewal failed:", expect.any(Error))
      } finally {
        error.mockRestore()
        await fs.rm(root, { recursive: true, force: true })
      }
    },
  )

  test.each(["use-remote", "keep-session"] as const)(
    "installs a fresh in-memory credential before %s conflict recovery resumes writes",
    async (strategy) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `runtime-document-refresh-${strategy}-`))
      const authorizations: string[] = []
      globalThis.fetch = fetchDouble(mock(async (_url: string | URL | Request, init?: RequestInit) => {
        const authorization = new Headers(init?.headers).get("authorization") ?? ""
        authorizations.push(authorization)
        if (authorization === "Bearer expired-token") return new Response("conflict", { status: 409 })
        return Response.json({ version: `v${authorizations.length + 1}` })
      }))
      const app = new Hono().route(
        "/",
        RuntimeDocumentHydrationRoutes({
          workspaceRoot: root,
          trustedTransport: true,
          controlPlaneOrigin: "https://control.test",
          verifyJob: async () => ({}),
        }),
      )
      const hydrated = await (await app.request("/api/wr/documents/hydrate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId: "session_refresh",
            documentId: `document_${strategy}`,
            displayName: "Plan",
            markdown: "before",
            baseVersion: "v1",
            job: {
              token: "hydrate-job",
              userId: "user_1",
              orgId: "org_1",
              projectId: "project_1",
              localWorkspaceId: "local_1",
              cloudWorkspaceId: "cloud_1",
            },
            writeback: {
              url: "https://control.test/write",
              renewUrl: "https://control.test/renew",
              token: "expired-token",
              expiresAt: Date.now() + 500,
            },
          }),
        })).json() as { path: string }
      await activateRuntimeDocument(app, "session_refresh", `document_${strategy}`)
      await fs.writeFile(hydrated.path, "session draft")
      await expect(flushRuntimeDocument("session_refresh", `document_${strategy}`)).rejects.toThrow("conflicted")
      const resolved = await app.request(`/api/wr/documents/session_refresh/document_${strategy}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          strategy,
          remoteVersion: "v2",
          ...(strategy === "use-remote" ? { remoteMarkdown: "durable current" } : {}),
          writeback: {
            url: "https://control.test/write",
            renewUrl: "https://control.test/renew",
            token: "fresh-token",
            expiresAt: Date.now() + 300_000,
          },
          job: {
            token: "resolve-job",
            userId: "user_1",
            orgId: "org_1",
            projectId: "project_1",
            localWorkspaceId: "local_1",
            cloudWorkspaceId: "cloud_1",
          },
        }),
      })
      expect(resolved.status).toBe(200)
      await fs.writeFile(hydrated.path, `${strategy} next edit`)
      await expect(flushRuntimeDocument("session_refresh", `document_${strategy}`)).resolves.toBeUndefined()
      expect(authorizations.at(-1)).toBe("Bearer fresh-token")
      expect(
        await fs.readFile(path.join(root, ".claxedo", "sessions", "session_refresh", "docs", "manifest.json"), "utf8"),
      ).not.toContain("fresh-token")
      await fs.rm(root, { recursive: true, force: true })
    },
  )

  test("keeps a conflicted runtime safely parked when credential refresh is invalid", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-document-refresh-invalid-"))
    globalThis.fetch = fetchDouble(mock(async () => new Response("conflict", { status: 409 })))
    const app = new Hono().route(
      "/",
      RuntimeDocumentHydrationRoutes({
        workspaceRoot: root,
        trustedTransport: true,
        controlPlaneOrigin: "https://control.test",
        verifyJob: async () => ({}),
      }),
    )
    const hydrated = await (await app.request("/api/wr/documents/hydrate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: "session_invalid",
          documentId: "document_invalid",
          displayName: "Plan",
          markdown: "before",
          baseVersion: "v1",
          job: {
            token: "hydrate",
            userId: "user_1",
            orgId: "org_1",
            projectId: "project_1",
            localWorkspaceId: "local_1",
            cloudWorkspaceId: "cloud_1",
          },
          writeback: {
            url: "https://control.test/write",
            renewUrl: "https://control.test/renew",
            token: "expired",
            expiresAt: Date.now() + 500,
          },
        }),
      })).json() as { path: string }
    await activateRuntimeDocument(app, "session_invalid", "document_invalid")
    await fs.writeFile(hydrated.path, "draft")
    await expect(flushRuntimeDocument("session_invalid", "document_invalid")).rejects.toThrow("conflicted")
    expect(
      (
        await app.request("/api/wr/documents/session_invalid/document_invalid/resolve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            strategy: "keep-session",
            remoteVersion: "v2",
            writeback: {
              url: "https://control.test/write",
              renewUrl: "https://control.test/renew",
              token: "bad",
              expiresAt: Date.now() - 1,
            },
            job: {
              token: "resolve",
              userId: "user_1",
              orgId: "org_1",
              projectId: "project_1",
              localWorkspaceId: "local_1",
              cloudWorkspaceId: "cloud_1",
            },
          }),
        })
      ).status,
    ).toBe(400)
    await expect(flushRuntimeDocument("session_invalid", "document_invalid")).rejects.toThrow("conflicted")
    await fs.rm(root, { recursive: true, force: true })
  })

  test("fails closed without the relay-owned hydration transport", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-document-local-"))
    const app = new Hono().route("/", RuntimeDocumentHydrationRoutes({ workspaceRoot: root }))
    const response = await app.request("/api/wr/documents/hydrate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "session_1",
        documentId: "document_1",
        displayName: "Plan",
        markdown: "before",
        baseVersion: "v1",
        job: {
          token: "job-token",
          userId: "user_1",
          orgId: "org_1",
          projectId: "project_1",
          localWorkspaceId: "ws_1",
          cloudWorkspaceId: "ws_1",
        },
        writeback: {
          url: "https://attacker.test/write",
          renewUrl: "https://attacker.test/renew",
          token: "secret-token",
          expiresAt: Date.now() + 300_000,
        },
      }),
    })
    expect(response.status).toBe(404)
    expect(await fs.readdir(root)).toEqual([])
    await fs.rm(root, { recursive: true, force: true })
  })

  test("rejects a writeback origin outside the configured control plane", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-document-origin-"))
    const app = new Hono().route(
      "/",
      RuntimeDocumentHydrationRoutes({
        workspaceRoot: root,
        trustedTransport: true,
        controlPlaneOrigin: "https://control.test",
        verifyJob: async () => ({}),
      }),
    )
    const response = await app.request("/api/wr/documents/hydrate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "session_1",
        documentId: "document_1",
        displayName: "Plan",
        markdown: "before",
        baseVersion: "v1",
        job: {
          token: "job-token",
          userId: "user_1",
          orgId: "org_1",
          projectId: "project_1",
          localWorkspaceId: "ws_1",
          cloudWorkspaceId: "ws_1",
        },
        writeback: {
          url: "https://attacker.test/write",
          renewUrl: "https://attacker.test/renew",
          token: "secret-token",
          expiresAt: Date.now() + 300_000,
        },
      }),
    })
    expect(response.status).toBe(403)
    expect(await fs.readdir(root)).toEqual([])
    await fs.rm(root, { recursive: true, force: true })
  })

  test("rejects relay-authenticated hydration without the dedicated document job audience", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-document-job-auth-"))
    const app = new Hono().route(
      "/",
      RuntimeDocumentHydrationRoutes({
        workspaceRoot: root,
        trustedTransport: true,
        controlPlaneOrigin: "https://control.test",
        verifyJob: async () => {
          throw new Error("wrong audience")
        },
      }),
    )
    const response = await app.request("/api/wr/documents/hydrate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "session_1",
        documentId: "document_1",
        displayName: "Plan",
        markdown: "before",
        baseVersion: "v1",
        job: {
          token: "editor-rat",
          userId: "user_1",
          orgId: "org_1",
          projectId: "project_1",
          localWorkspaceId: "local_1",
          cloudWorkspaceId: "cloud_1",
        },
        writeback: {
          url: "https://control.test/write",
          renewUrl: "https://control.test/renew",
          token: "write-token",
          expiresAt: Date.now() + 300_000,
        },
      }),
    })
    expect(response.status).toBe(403)
    expect(await fs.readdir(root)).toEqual([])
    await fs.rm(root, { recursive: true, force: true })
  })

  test("flushes a recovered dirty manifest only after explicit capability activation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-document-restart-"))
    let canonical = "before"
    const fetcher = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      canonical = (JSON.parse(String(init?.body)) as { markdown: string }).markdown
      return Response.json({ version: "v2" })
    })
    globalThis.fetch = fetchDouble(fetcher)
    const app = new Hono().route(
      "/",
      RuntimeDocumentHydrationRoutes({
        workspaceRoot: root,
        trustedTransport: true,
        controlPlaneOrigin: "https://control.test",
        verifyJob: async () => ({}),
      }),
    )
    const body = {
      sessionId: "session_1",
      documentId: "document_1",
      displayName: "Plan",
      markdown: canonical,
      baseVersion: "v1",
      job: {
        token: "job-token",
        userId: "user_1",
        orgId: "org_1",
        projectId: "project_1",
        localWorkspaceId: "ws_1",
        cloudWorkspaceId: "ws_1",
      },
      writeback: {
        url: "https://control.test/write",
        renewUrl: "https://control.test/renew",
        token: "secret-token",
        expiresAt: Date.now() + 300_000,
      },
    }
    const first = await (await app.request("/api/wr/documents/hydrate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })).json() as { path: string }
    await fs.writeFile(first.path, "dirty after crash")
    forgetRuntimeDocuments()
    const second = await app.request("/api/wr/documents/hydrate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    expect(second.status).toBe(200)
    expect(canonical).toBe("before")
    const activated = await app.request("/api/wr/documents/session_1/document_1/activate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(activated.status).toBe(200)
    expect(canonical).toBe("dirty after crash")
    expect(await fs.readFile(first.path, "utf8")).toBe("dirty after crash")
    await fs.rm(root, { recursive: true, force: true })
  })

  test("keeps edits, flushes, watchers, and renewal inert while activation is pending or rejected", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-document-pending-activation-"))
    const activationEntered = deferred<void>()
    const rejectActivation = deferred<void>()
    const timer = renewalTimer(1_000_000)
    const callback = mock(async () => Response.json({ version: "v2" }))
    globalThis.fetch = fetchDouble(callback)
    const app = new Hono().route(
      "/",
      RuntimeDocumentHydrationRoutes({
        workspaceRoot: root,
        trustedTransport: true,
        controlPlaneOrigin: "https://control.test",
        renewalTimer: timer,
        verifyJob: async (_token, expected) => {
          if (expected.operation !== "write") return {}
          activationEntered.resolve()
          await rejectActivation.promise
          throw new Error("activation rejected")
        },
      }),
    )
    const hydrated = await (await app.request("/api/wr/documents/hydrate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(hydrationBody("session_pending", "document_pending")),
      })).json() as { path: string }
    const activating = app.request("/api/wr/documents/session_pending/document_pending/activate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    await activationEntered.promise
    await fs.writeFile(hydrated.path, "edit while activation hangs")
    await Bun.sleep(150)
    await expect(flushRuntimeDocument("session_pending", "document_pending")).rejects.toThrow("not activated")
    expect(callback).not.toHaveBeenCalled()
    expect(timer.delays()).toEqual([])

    rejectActivation.resolve()
    expect((await activating).status).toBe(403)
    await Bun.sleep(150)
    await expect(flushRuntimeDocument("session_pending", "document_pending")).rejects.toThrow("not activated")
    expect(callback).not.toHaveBeenCalled()
    expect(timer.delays()).toEqual([])
    await fs.rm(root, { recursive: true, force: true })
  })

  test("uses the persisted dirty base version for the first write-back after restart", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-document-restart-cas-"))
    const versions: string[] = []
    globalThis.fetch = fetchDouble(mock(async (_url: string | URL | Request, init?: RequestInit) => {
      versions.push(new Headers(init?.headers).get("if-match") ?? "")
      return new Response("conflict", { status: 409 })
    }))
    const app = new Hono().route(
      "/",
      RuntimeDocumentHydrationRoutes({
        workspaceRoot: root,
        trustedTransport: true,
        controlPlaneOrigin: "https://control.test",
        verifyJob: async () => ({}),
      }),
    )
    const body = {
      sessionId: "session_restart",
      documentId: "document_restart",
      displayName: "Plan",
      markdown: "remote v1",
      baseVersion: "v1",
      job: {
        token: "job",
        userId: "user_1",
        orgId: "org_1",
        projectId: "project_1",
        localWorkspaceId: "local_1",
        cloudWorkspaceId: "cloud_1",
      },
      writeback: {
        url: "https://control.test/write",
        renewUrl: "https://control.test/renew",
        token: "write",
        expiresAt: Date.now() + 300_000,
      },
    }
    const hydrated = await (await app.request("/api/wr/documents/hydrate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })).json() as { path: string }
    await fs.writeFile(hydrated.path, "dirty from v1")
    forgetRuntimeDocuments()

    const restarted = await app.request("/api/wr/documents/hydrate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, markdown: "remote v2", baseVersion: "v2" }),
    })

    expect(restarted.status).toBe(200)
    const activated = await app.request("/api/wr/documents/session_restart/document_restart/activate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(activated.status).toBe(500)
    expect(versions).toEqual(["v1"])
    expect(await fs.readFile(hydrated.path, "utf8")).toBe("dirty from v1")
    expect(
      JSON.parse(
        await fs.readFile(path.join(root, ".claxedo", "sessions", "session_restart", "docs", "manifest.json"), "utf8"),
      ),
    ).toMatchObject({ documents: [{ baseVersion: "v1", state: "conflicted" }] })
    await fs.rm(root, { recursive: true, force: true })
  })

  test("rejects symlinked hydration roots without writing outside the workspace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-document-link-"))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-document-outside-"))
    await fs.symlink(outside, path.join(root, ".claxedo"))
    const app = new Hono().route(
      "/",
      RuntimeDocumentHydrationRoutes({
        workspaceRoot: root,
        trustedTransport: true,
        controlPlaneOrigin: "https://control.test",
        verifyJob: async () => ({}),
      }),
    )
    const response = await app.request("/api/wr/documents/hydrate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "session_1",
        documentId: "document_1",
        displayName: "Plan",
        markdown: "secret",
        baseVersion: "v1",
        job: {
          token: "job-token",
          userId: "user_1",
          orgId: "org_1",
          projectId: "project_1",
          localWorkspaceId: "ws_1",
          cloudWorkspaceId: "ws_1",
        },
        writeback: {
          url: "https://control.test/write",
          renewUrl: "https://control.test/renew",
          token: "secret-token",
          expiresAt: Date.now() + 300_000,
        },
      }),
    })
    expect(response.status).toBe(500)
    expect(await fs.readdir(outside)).toEqual([])
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  })

  test("detects an intermediate directory swap before mutating outside content", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-document-swap-"))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-document-swap-outside-"))
    await fs.writeFile(path.join(outside, "plan.md"), "outside")
    const app = new Hono().route(
      "/",
      RuntimeDocumentHydrationRoutes({
        workspaceRoot: root,
        trustedTransport: true,
        controlPlaneOrigin: "https://control.test",
        verifyJob: async () => ({}),
        beforeWriteOpen: async () => {
          const directory = path.join(root, ".claxedo", "sessions", "session_1", "docs", "document_1")
          await fs.rename(directory, `${directory}.moved`)
          await fs.symlink(outside, directory)
        },
      }),
    )
    const response = await app.request("/api/wr/documents/hydrate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "session_1",
        documentId: "document_1",
        displayName: "Plan",
        markdown: "secret",
        baseVersion: "v1",
        job: {
          token: "job",
          userId: "user_1",
          orgId: "org_1",
          projectId: "project_1",
          localWorkspaceId: "local_1",
          cloudWorkspaceId: "cloud_1",
        },
        writeback: {
          url: "https://control.test/write",
          renewUrl: "https://control.test/renew",
          token: "write",
          expiresAt: Date.now() + 300_000,
        },
      }),
    })
    expect(response.status).toBe(500)
    expect(await fs.readFile(path.join(outside, "plan.md"), "utf8")).toBe("outside")
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  })
})

function renewalTimer(time: number) {
  const tasks: Array<{ callback: () => void; delay: number; cleared: boolean }> = []
  return {
    now: () => time,
    set: ((callback: () => void, delay = 0) => {
      tasks.push({ callback, delay, cleared: false })
      return tasks.length as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout,
    clear: ((handle: ReturnType<typeof setTimeout>) => {
      const task = tasks[Number(handle) - 1]
      if (task) task.cleared = true
    }) as typeof clearTimeout,
    delays: () => tasks.map((task) => task.delay),
    cleared: (index: number) => tasks[index]?.cleared ?? false,
    run: (index: number) => {
      const task = tasks[index]
      if (!task || task.cleared) return
      task.callback()
    },
  }
}

function hydrationBody(sessionId: string, documentId: string) {
  return {
    sessionId,
    documentId,
    displayName: "Plan",
    markdown: "before",
    baseVersion: "v1",
    job: {
      token: "job",
      userId: "user_1",
      orgId: "org_1",
      projectId: "project_1",
      localWorkspaceId: "local_1",
      cloudWorkspaceId: "cloud_1",
    },
    writeback: {
      url: `https://control.test/documents/${documentId}/runtime-writeback`,
      renewUrl: `https://control.test/documents/${documentId}/runtime-capability/renew`,
      token: "write",
      expiresAt: Date.now() + 300_000,
    },
  }
}

async function activateRuntimeDocument(app: Hono, sessionId: string, documentId: string) {
  const response = await app.request(`/api/wr/documents/${sessionId}/${documentId}/activate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  })
  expect(response.status).toBe(200)
  return response
}

function callbackResponse(
  failure: "stalled" | "declared oversized" | "chunked oversized",
  value: Record<string, unknown>,
) {
  if (failure === "declared oversized") {
    return new Response(JSON.stringify(value), { headers: { "content-length": String(64 * 1024 + 1) } })
  }
  if (failure === "chunked oversized") {
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(64 * 1024))
          controller.enqueue(new Uint8Array([1]))
          controller.close()
        },
      }),
    )
  }
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(value).slice(0, -1)))
      },
    }),
  )
}

async function waitFor(condition: () => boolean | Promise<boolean>) {
  // ~100ms was not enough on a loaded CI runner (run 363: the parked-draft
  // condition arrived just past it). The loop exits on the first true, so a
  // generous ceiling costs passing tests nothing.
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (await condition()) return
    await Bun.sleep(5)
  }
  throw new Error("Timed out waiting for condition")
}

function deferred<T>() {
  let resolve = (_value: T | PromiseLike<T>): void => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function exists(value: string) {
  return fs.access(value).then(
    () => true,
    () => false,
  )
}
