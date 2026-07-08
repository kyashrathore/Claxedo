import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { exportJWK, exportSPKI, generateKeyPair } from "jose"
import {
  createWorkspaceRelayBun,
  mintRuntimeAccessToken,
  type WorkspaceRelayAuditEvent,
} from "@claxedo/workspace-relay"
import { startServer, waitForWorkspaceRuntimeServerPort } from "./server"
import { relayWorkspaceRuntimeExposure } from "./exposure"

const NativeResponse = globalThis.Response

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

async function relayHarness() {
  const runtime = await generateKeyPair("EdDSA", { extractable: true })
  const relayHost = await generateKeyPair("EdDSA", { extractable: true })
  const revokedJti = "revoked_1"
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-relay-e2e-"))
  const previousDirectory = process.env.WORKSPACE_RUNTIME_DIRECTORY
  const previousWorkspaceId = process.env.WORKSPACE_RUNTIME_WORKSPACE_ID
  process.env.WORKSPACE_RUNTIME_DIRECTORY = workspaceDir
  process.env.WORKSPACE_RUNTIME_WORKSPACE_ID = "ws_1"
  const relayHostAudits: unknown[] = []
  const relayAudits: WorkspaceRelayAuditEvent[] = []
  const relayHostAuth = {
      key: relayHost.publicKey,
      workspaceId: "ws_1",
      hostId: "host_1",
      audit: (event) => {
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
    runtimeAccessToken: await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA"),
    revokedRuntimeAccessToken: await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
      jti: revokedJti,
    }, runtime.privateKey, "EdDSA"),
    expiredRuntimeAccessToken: await mintRuntimeAccessToken({
      subject: "user_1",
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
    new Promise<string>((_resolve, reject) => setTimeout(() => reject(new Error(`Workspace Runtime did not announce a port\n${logs.join("")}`)), 5_000)),
  ])
  try {
    await waitForRuntime(runtimeUrl)
  } catch (err) {
    await stopChild(child)
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
    runtimeAccessToken: await mintRuntimeAccessToken({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA"),
    async close() {
      relayServer.stop(true)
      await stopChild(child)
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

      const pty = await relayFetch("/api/wr/pty", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "/bin/sh",
          cwd: ".",
        }),
      })
      expect(pty.status).toBe(200)
      const info = await pty.json() as { id: string }
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

      const pty = await relayFetch("/api/wr/pty", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "/bin/sh",
          cwd: ".",
        }),
      })
      expect(pty.status).toBe(200)
      const info = await pty.json() as { id: string }

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
  }, 20_000)
})
