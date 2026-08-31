import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { exportSPKI, generateKeyPair } from "jose"
import {
  createWorkspaceRelayBun,
  mintRuntimeAccessToken,
  verifyRelayHostToken,
  type WorkspaceRelayAuditEvent,
} from "@claxedo/workspace-relay"
import type { RelayHostAuthAuditEvent } from "./workspace-host-service-auth"
import { startServer, waitForWorkspaceRuntimeServerPort } from "./server"
import { relayWorkspaceRuntimeExposure } from "./exposure"
import { WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL } from "./remote-session-authority"

const NativeResponse = globalThis.Response

/**
 * How long the process-separated harness waits for its child runtime to
 * announce a port. The child is node + tsx transforming the whole runtime entry
 * from cold: ~900ms here, measured >5s under 2-core CI contention.
 */
const PORT_ANNOUNCE_TIMEOUT_MS = 30_000

/**
 * Budget for the process-separated test, and it must stay comfortably above
 * PORT_ANNOUNCE_TIMEOUT_MS + the waitForRuntime poll (200 * 25ms) that follows
 * it. At 20s it did not, so a boot slower than 20s could never reach the
 * harness's own deadline: the test died first on `this test timed out after
 * 20000ms`, reporting nothing about the child that was actually slow. That is
 * how this went red in CI while every assertion in the body was fine.
 *
 * The ordering is the point, not the number. The innermost deadline has to be
 * the one that fires, because it is the only one that knows what it was waiting
 * for and can print the child's log with it.
 */
const PROCESS_SEPARATED_TIMEOUT_MS = 60_000

async function waitForRuntime(url: string) {
  for (let i = 0; i < 200; i++) {
    const res = await fetch(`${url}/global/health`).catch(() => undefined)
    if (res?.ok) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("Workspace Runtime did not become ready")
}

async function waitForOpen(ws: WebSocket) {
  return await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WebSocket did not open")), 5_000)
    ws.onopen = () => {
      clearTimeout(timeout)
      resolve()
    }
    ws.onerror = () => {
      clearTimeout(timeout)
      reject(new Error("WebSocket failed to open"))
    }
  })
}

function textMessage(input: MessageEvent["data"]) {
  if (typeof input === "string") return input
  if (input instanceof ArrayBuffer) return new TextDecoder().decode(input)
  if (ArrayBuffer.isView(input)) return new TextDecoder().decode(input)
  return ""
}

async function waitForMessage(ws: WebSocket, predicate: (message: string) => boolean) {
  return await new Promise<string>((resolve, reject) => {
    const seen: string[] = []
    const timeout = setTimeout(
      () => reject(new Error(`Expected WebSocket message was not received; saw ${JSON.stringify(seen)}`)),
      5_000,
    )
    ws.onmessage = (event) => {
      const message = textMessage(event.data)
      seen.push(message)
      if (!predicate(message)) return
      clearTimeout(timeout)
      resolve(message)
    }
    ws.onerror = () => {
      clearTimeout(timeout)
      reject(new Error("WebSocket failed while waiting for message"))
    }
  })
}

async function readAll(reader: ReadableStreamDefaultReader<Uint8Array>, first?: Uint8Array) {
  const chunks = first ? [first] : []
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    chunks.push(next.value)
  }
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
  chunks.reduce((offset, chunk) => {
    out.set(chunk, offset)
    return offset + chunk.byteLength
  }, 0)
  return out
}

/**
 * The relay-exposed runtime composes `remoteWorkspaceSessionAccessPolicy`, so
 * every session-scoped operation (PTY create included) is decided by a control
 * plane over HTTP. These e2e tests own no control plane, so they stand up the
 * narrowest possible one: it authorizes exactly the session the test creates a
 * PTY for, for exactly the actor the Runtime Access Token carries, and denies
 * everything else. Anything looser would stop proving that the runtime actually
 * consults the authority — the whole point of the M2c seam.
 */
function sessionAuthorityStub(input: {
  sessionId: string
  actorId: string
  relayHostKey: CryptoKey
  workspaceId: string
  hostId: string
}) {
  const requests: Array<{ sessionId?: string; action?: string; actorId?: string }> = []
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = await request.json().catch(() => ({})) as {
        sessionId?: string
        action?: string
        stream?: boolean
        lease?: string
      }
      // The proof is the Relay Host Token the runtime forwarded verbatim. A real
      // control plane verifies it to learn *who* is asking; so does this stub,
      // because a stub that trusted the body would let an unsigned request pass.
      const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
      const claims = token
        ? await verifyRelayHostToken(token, input.relayHostKey, {
            workspaceId: input.workspaceId,
            hostId: input.hostId,
          }).catch(() => undefined)
        : undefined
      requests.push({ sessionId: body.sessionId, action: body.action, actorId: claims?.actor_id })
      if (!claims || claims.actor_id !== input.actorId) return new Response(null, { status: 401 })
      if (body.sessionId !== input.sessionId) return new Response(null, { status: 403 })
      return Response.json(body.stream
        ? {
            allowed: true,
            lease: body.lease ?? `stream_${body.action ?? "read"}`,
            expiresAt: Date.now() + 30_000,
          }
        : { allowed: true })
    },
  })
  return {
    requests,
    url: `${String(server.url).replace(/\/$/, "")}/session-authorize`,
    stop: () => server.stop(true),
  }
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode) return
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL")
      resolve()
    }, 3_000)
    child.once("exit", () => {
      clearTimeout(timeout)
      resolve()
    })
    child.kill("SIGTERM")
  })
}

/** The one session these harnesses authorize a PTY for. */
const PTY_SESSION_ID = "ses_relay_e2e"

async function relayHarness() {
  const runtime = await generateKeyPair("EdDSA", { extractable: true })
  const relayHost = await generateKeyPair("EdDSA", { extractable: true })
  const revokedJti = "revoked_1"
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-relay-e2e-"))
  const previousDirectory = process.env.WORKSPACE_RUNTIME_DIRECTORY
  const previousWorkspaceId = process.env.WORKSPACE_RUNTIME_WORKSPACE_ID
  const previousAuthorityUrl = process.env[WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL]
  const authority = sessionAuthorityStub({
    sessionId: PTY_SESSION_ID,
    actorId: "actor_1",
    relayHostKey: relayHost.publicKey,
    workspaceId: "ws_1",
    hostId: "host_1",
  })
  process.env.WORKSPACE_RUNTIME_DIRECTORY = workspaceDir
  process.env.WORKSPACE_RUNTIME_WORKSPACE_ID = "ws_1"
  process.env[WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL] = authority.url
  const relayHostAudits: RelayHostAuthAuditEvent[] = []
  const relayAudits: WorkspaceRelayAuditEvent[] = []
  const relayHostAuth = {
      key: relayHost.publicKey,
      workspaceId: "ws_1",
      hostId: "host_1",
      audit: (event: RelayHostAuthAuditEvent) => {
        relayHostAudits.push(event)
      },
    }
  const runtimeServer = startServer(0, {
    exposure: relayWorkspaceRuntimeExposure(relayHostAuth),
    relayHostAuth,
  })
  globalThis.Response = NativeResponse
  const runtimeUrl = `http://127.0.0.1:${await waitForWorkspaceRuntimeServerPort(runtimeServer, 0)}`
  await waitForRuntime(runtimeUrl)

  const relayHandler = createWorkspaceRelayBun({
    runtimeAccessKey: runtime.publicKey,
    relayHostSigningKey: relayHost.privateKey,
    relayHostAlgorithm: "EdDSA",
    resolveTarget: (claims) => ({
      workspaceId: claims.workspace_id,
      hostId: claims.host_id,
      baseUrl: runtimeUrl,
      access: "cloud",
      backing: "cloud-vm",
    }),
    isRuntimeAccessTokenActive: (claims) =>
      claims.jti === revokedJti
        ? {
            active: false,
            code: "runtime_access_token_revoked",
            reason: "Runtime Access Token has been revoked",
          }
        : { active: true },
    audit: (event) => {
      relayAudits.push(event)
    },
  })
  const relayServer = Bun.serve({
    port: 0,
    fetch: relayHandler.fetch,
    websocket: relayHandler.websocket,
  })
  return {
    workspaceDir,
    runtimeUrl,
    relayUrl: String(relayServer.url).replace(/\/$/, ""),
    relayHostAudits,
    relayAudits,
    sessionId: PTY_SESSION_ID,
    authorityRequests: authority.requests,
    runtimeAccessToken: await mintRuntimeAccessToken({
      subject: "user_1",
      actorId: "actor_1",
      actorKind: "human",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA"),
    viewerRuntimeAccessToken: await mintRuntimeAccessToken({
      subject: "viewer_1",
      actorId: "actor_viewer",
      actorKind: "human",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "viewer",
    }, runtime.privateKey, "EdDSA"),
    revokedRuntimeAccessToken: await mintRuntimeAccessToken({
      subject: "user_1",
      actorId: "actor_1",
      actorKind: "human",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
      jti: revokedJti,
    }, runtime.privateKey, "EdDSA"),
    expiredRuntimeAccessToken: await mintRuntimeAccessToken({
      subject: "user_1",
      actorId: "actor_1",
      actorKind: "human",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
      ttlSeconds: 1,
      now: Date.now() - 60_000,
    }, runtime.privateKey, "EdDSA"),
    async close() {
      relayServer.stop(true)
      runtimeServer.close()
      authority.stop()
      if (previousAuthorityUrl === undefined) {
        delete process.env[WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL]
      } else {
        process.env[WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL] = previousAuthorityUrl
      }
      if (previousDirectory === undefined) {
        delete process.env.WORKSPACE_RUNTIME_DIRECTORY
      } else {
        process.env.WORKSPACE_RUNTIME_DIRECTORY = previousDirectory
      }
      if (previousWorkspaceId === undefined) {
        delete process.env.WORKSPACE_RUNTIME_WORKSPACE_ID
      } else {
        process.env.WORKSPACE_RUNTIME_WORKSPACE_ID = previousWorkspaceId
      }
      await fs.rm(workspaceDir, { recursive: true, force: true })
    },
  }
}

async function processSeparatedRelayHarness() {
  const runtime = await generateKeyPair("EdDSA", { extractable: true })
  const relayHost = await generateKeyPair("EdDSA", { extractable: true })
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-relay-process-e2e-"))
  const authority = sessionAuthorityStub({
    sessionId: PTY_SESSION_ID,
    actorId: "actor_1",
    relayHostKey: relayHost.publicKey,
    workspaceId: "ws_1",
    hostId: "host_1",
  })
  const logs: string[] = []
  let resolveRuntimeUrl!: (url: string) => void
  let rejectRuntimeUrl!: (error: Error) => void
  const runtimeUrlFromLog = new Promise<string>((resolve, reject) => {
    resolveRuntimeUrl = resolve
    rejectRuntimeUrl = reject
  })
  const readLog = (chunk: Buffer) => {
    const text = chunk.toString()
    logs.push(text)
    const match = logs.join("").match(/\[workspace-runtime\] listening on http:\/\/[^:]+:(\d+)/)
    if (match) resolveRuntimeUrl(`http://127.0.0.1:${match[1]}`)
  }
  const child = spawn(process.env.CLAXEDO_TEST_NODE ?? "node", [
    "--import",
    "./src/text-imports.mjs",
    "--import",
    "tsx",
    "src/workspace-relay-e2e-entry.ts",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      WORKSPACE_RUNTIME_PORT: "0",
      WORKSPACE_RUNTIME_DIRECTORY: workspaceDir,
      WORKSPACE_RUNTIME_WORKSPACE_ID: "ws_1",
      WORKSPACE_RUNTIME_HOST_ID: "host_1",
      WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM: await exportSPKI(relayHost.publicKey),
      [WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL]: authority.url,
      OPENCODE_URL: "http://127.0.0.1:4096",
      OPENCODE_PTY_ORPHAN_TIMEOUT_MS: "1000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout?.on("data", readLog)
  child.stderr?.on("data", readLog)
  child.once("exit", (code, signal) => {
    rejectRuntimeUrl(new Error(`Workspace Runtime exited before announcing a port code=${code} signal=${signal}\n${logs.join("")}`))
  })

  const runtimeUrl = await Promise.race([
    runtimeUrlFromLog,
    new Promise<string>((_resolve, reject) =>
      setTimeout(
        () => reject(new Error(`Workspace Runtime did not announce a port after ${PORT_ANNOUNCE_TIMEOUT_MS}ms\n${logs.join("")}`)),
        PORT_ANNOUNCE_TIMEOUT_MS,
      ),
    ),
  ])
  try {
    await waitForRuntime(runtimeUrl)
  } catch (err) {
    await stopChild(child)
    authority.stop()
    await fs.rm(workspaceDir, { recursive: true, force: true })
    throw new Error(`${err instanceof Error ? err.message : String(err)}\n${logs.join("")}`)
  }

  const relayAudits: WorkspaceRelayAuditEvent[] = []
  const relayHandler = createWorkspaceRelayBun({
    runtimeAccessKey: runtime.publicKey,
    relayHostSigningKey: relayHost.privateKey,
    relayHostAlgorithm: "EdDSA",
    resolveTarget: (claims) => ({
      workspaceId: claims.workspace_id,
      hostId: claims.host_id,
      baseUrl: runtimeUrl,
      access: "cloud",
      backing: "cloud-vm",
    }),
    audit: (event) => {
      relayAudits.push(event)
    },
  })
  const relayServer = Bun.serve({
    port: 0,
    fetch: relayHandler.fetch,
    websocket: relayHandler.websocket,
  })

  return {
    workspaceDir,
    runtimeUrl,
    relayUrl: String(relayServer.url).replace(/\/$/, ""),
    relayAudits,
    sessionId: PTY_SESSION_ID,
    authorityRequests: authority.requests,
    runtimeAccessToken: await mintRuntimeAccessToken({
      subject: "user_1",
      actorId: "actor_1",
      actorKind: "human",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA"),
    async close() {
      relayServer.stop(true)
      await stopChild(child)
      authority.stop()
      await fs.rm(workspaceDir, { recursive: true, force: true })
    },
  }
}

describe("workspace relay composed runtime path", () => {
  test("forwards HTTP raw file streams and PTY WebSockets through a Relay Host Token guarded runtime", async () => {
    const relay = await relayHarness()
    let ws: WebSocket | undefined

    try {
      const direct = await fetch(`${relay.runtimeUrl}/api/wr/health`)
      expect(direct.status).toBe(401)
      const directRuntimeAccessToken = await fetch(`${relay.runtimeUrl}/api/wr/health`, {
        headers: {
          authorization: `Bearer ${relay.runtimeAccessToken}`,
        },
      })
      expect(directRuntimeAccessToken.status).toBe(401)
      await expect(directRuntimeAccessToken.json()).resolves.toMatchObject({
        error: {
          code: "invalid_relay_token",
        },
      })

      const relayFetch = (path: string, init: RequestInit = {}, token = relay.runtimeAccessToken) =>
        fetch(`${relay.relayUrl}/workspaces/ws_1${path}`, {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init.headers).entries()),
            authorization: `Bearer ${token}`,
          },
        })

      const health = await relayFetch("/api/wr/health")
      expect(health.status).toBe(200)
      await expect(health.json()).resolves.toMatchObject({
        service: "workspace-runtime",
      })

      const viewerHealth = await relayFetch("/api/wr/health", {}, relay.viewerRuntimeAccessToken)
      expect(viewerHealth.status).toBe(200)
      const viewerPty = await relayFetch("/api/wr/pty", {}, relay.viewerRuntimeAccessToken)
      expect(viewerPty.status).toBe(403)
      await expect(viewerPty.json()).resolves.toEqual({
        error: {
          code: "relay_role_denied",
          message: "Workspace role does not allow this relay request",
        },
      })

      const revoked = await relayFetch("/api/wr/health", {}, relay.revokedRuntimeAccessToken)
      expect(revoked.status).toBe(401)
      await expect(revoked.json()).resolves.toEqual({
        error: {
          code: "runtime_access_token_revoked",
          message: "Runtime Access Token has been revoked",
        },
      })

      const expired = await relayFetch("/api/wr/health", {}, relay.expiredRuntimeAccessToken)
      expect(expired.status).toBe(401)
      await expect(expired.json()).resolves.toEqual({
        error: {
          code: "invalid_relay_token",
          message: "Workspace relay request was denied",
        },
      })

      const large = Uint8Array.from({ length: 128 * 1024 }, (_, index) => index % 251)
      await fs.writeFile(path.join(relay.workspaceDir, "large.bin"), large)
      const raw = await relayFetch("/file/raw?path=large.bin")
      expect(raw.status).toBe(200)
      expect(raw.headers.get("content-type")).toBe("application/octet-stream")
      const rawReader = raw.body!.getReader()
      const first = await rawReader.read()
      expect(first.done).toBe(false)
      expect(first.value!.byteLength).toBeGreaterThan(0)
      expect(first.value).toEqual(large.slice(0, first.value!.byteLength))
      expect(await readAll(rawReader, first.value)).toEqual(large)

      // A relay 503 here is `upstream_unavailable`: its proxied fetch to the
      // runtime child threw at that instant (a reused keep-alive socket the
      // child had already dropped) — transient by construction, since the
      // raw-file stream above just round-tripped through the same runtime.
      // Retry that one case briefly instead of failing the suite on it.
      const createPty = () =>
        relayFetch("/api/wr/pty", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            // A relay-exposed PTY is bound to its creating session; the runtime
            // rejects a session-less create so the authority has something to gate.
            sessionId: relay.sessionId,
            command: "/bin/sh",
            cwd: ".",
          }),
        })
      let pty = await createPty()
      for (let attempt = 0; pty.status === 503 && attempt < 20; attempt++) {
        await Bun.sleep(100)
        pty = await createPty()
      }
      expect(pty.status).toBe(200)
      const info = await pty.json() as { id: string }
      expect(relay.authorityRequests).toContainEqual({
        sessionId: relay.sessionId,
        action: "write",
        actorId: "actor_1",
      })
      // Bun WS clients send no Origin header by default, but
      // the relay's `requireAllowedOrigin` enforces one on WS upgrades.
      // Pass an explicit allowed origin via bun's extended constructor.
      ws = new (WebSocket as unknown as {
        new(url: string, options: { headers?: Record<string, string>; protocols?: string[] }): WebSocket
      })(
        `${relay.relayUrl}/workspaces/ws_1/api/wr/pty/${encodeURIComponent(info.id)}/connect?cursor=0`
          .replace(/^http/, "ws"),
        {
          headers: { origin: "http://localhost:3000" },
          protocols: [`claxedo-rat.${relay.runtimeAccessToken}`],
        },
      )
      ws.binaryType = "arraybuffer"
      await waitForOpen(ws)
      expect(await waitForMessage(ws, (message) => message.startsWith("\0") && message.includes("\"cursor\"")))
        .toContain("\"cursor\"")
      await relayFetch(`/api/wr/pty/${encodeURIComponent(info.id)}`, {
        method: "DELETE",
      })

      expect(relay.relayAudits).toContainEqual(expect.objectContaining({
        action: "relay.request.accepted",
        result: "allow",
        workspaceId: "ws_1",
        hostId: "host_1",
        path: "/workspaces/ws_1/api/wr/health",
      }))
      expect(relay.relayAudits).toContainEqual(expect.objectContaining({
        action: "relay.request.denied",
        result: "deny",
        reason: "runtime_access_token_revoked",
        workspaceId: "ws_1",
        hostId: "host_1",
        path: "/workspaces/ws_1/api/wr/health",
      }))
      expect(relay.relayAudits).toContainEqual(expect.objectContaining({
        action: "relay.request.denied",
        result: "deny",
        reason: "invalid_relay_token",
        path: "/workspaces/ws_1/api/wr/health",
      }))
      expect(relay.relayHostAudits).toContainEqual(expect.objectContaining({
        action: "relay_host_token.accepted",
        result: "allow",
        workspaceId: "ws_1",
        hostId: "host_1",
        path: "/api/wr/health",
      }))
    } finally {
      ws?.close()
      await relay.close()
    }
  }, 15_000)

  test("forwards raw file streams and PTY bytes to a process-separated Workspace Runtime", async () => {
    const relay = await processSeparatedRelayHarness()
    let ws: WebSocket | undefined

    try {
      const relayFetch = (route: string, init: RequestInit = {}) =>
        fetch(`${relay.relayUrl}/workspaces/ws_1${route}`, {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init.headers).entries()),
            authorization: `Bearer ${relay.runtimeAccessToken}`,
          },
        })

      const direct = await fetch(`${relay.runtimeUrl}/api/wr/health`)
      expect(direct.status).toBe(401)
      const directRuntimeAccessToken = await fetch(`${relay.runtimeUrl}/api/wr/health`, {
        headers: {
          authorization: `Bearer ${relay.runtimeAccessToken}`,
        },
      })
      expect(directRuntimeAccessToken.status).toBe(401)
      await expect(directRuntimeAccessToken.json()).resolves.toMatchObject({
        error: {
          code: "invalid_relay_token",
        },
      })

      const health = await relayFetch("/api/wr/health")
      expect(health.status).toBe(200)
      const healthBody = await health.json() as Record<string, unknown>
      expect(healthBody).toMatchObject({
        ok: true,
        status: "ready",
        service: "workspace-runtime",
        routeAuthBoundary: "relay-host-auth",
      })
      expect(healthBody).not.toHaveProperty("workspaceId")
      expect(healthBody).not.toHaveProperty("directory")
      expect(healthBody).not.toHaveProperty("capabilities")

      const large = Uint8Array.from({ length: 96 * 1024 }, (_, index) => (index * 7) % 251)
      await fs.writeFile(path.join(relay.workspaceDir, "process-separated.bin"), large)
      const raw = await relayFetch("/file/raw?path=process-separated.bin")
      expect(raw.status).toBe(200)
      const rawReader = raw.body!.getReader()
      const first = await rawReader.read()
      expect(first.done).toBe(false)
      expect(first.value!.byteLength).toBeGreaterThan(0)
      expect(first.value).toEqual(large.slice(0, first.value!.byteLength))
      expect(await readAll(rawReader, first.value)).toEqual(large)

      // A relay 503 here is `upstream_unavailable`: its proxied fetch to the
      // runtime child threw at that instant (a reused keep-alive socket the
      // child had already dropped) — transient by construction, since the
      // raw-file stream above just round-tripped through the same runtime.
      // Retry that one case briefly instead of failing the suite on it.
      const createPty = () =>
        relayFetch("/api/wr/pty", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            sessionId: relay.sessionId,
            command: "/bin/sh",
            cwd: ".",
          }),
        })
      let pty = await createPty()
      for (let attempt = 0; pty.status === 503 && attempt < 20; attempt++) {
        await Bun.sleep(100)
        pty = await createPty()
      }
      expect(pty.status).toBe(200)
      const info = await pty.json() as { id: string }
      expect(relay.authorityRequests).toContainEqual({
        sessionId: relay.sessionId,
        action: "write",
        actorId: "actor_1",
      })

      ws = new (WebSocket as unknown as {
        new(url: string, options: { headers?: Record<string, string>; protocols?: string[] }): WebSocket
      })(
        `${relay.relayUrl}/workspaces/ws_1/api/wr/pty/${encodeURIComponent(info.id)}/connect?cursor=0`
          .replace(/^http/, "ws"),
        {
          headers: { origin: "http://localhost:3000" },
          protocols: [`claxedo-rat.${relay.runtimeAccessToken}`],
        },
      )
      ws.binaryType = "arraybuffer"
      await waitForOpen(ws)
      await waitForMessage(ws, (message) => message.startsWith("\0") && message.includes("\"cursor\""))
      ws.send("printf 'process-separated-pty-ok\\n'\n")
      expect(await waitForMessage(ws, (message) => message.includes("process-separated-pty-ok")))
        .toContain("process-separated-pty-ok")
      await relayFetch(`/api/wr/pty/${encodeURIComponent(info.id)}`, {
        method: "DELETE",
      })

      expect(relay.relayAudits).toContainEqual(expect.objectContaining({
        action: "relay.request.accepted",
        result: "allow",
        workspaceId: "ws_1",
        hostId: "host_1",
        path: "/workspaces/ws_1/api/wr/health",
      }))
    } finally {
      ws?.close()
      await relay.close()
    }
  }, PROCESS_SEPARATED_TIMEOUT_MS)
})
