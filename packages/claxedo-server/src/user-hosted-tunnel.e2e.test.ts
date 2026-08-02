import { afterEach, beforeEach, describe, expect, test } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { promisify } from "node:util"
import { serve } from "@hono/node-server"
import { exportJWK, generateKeyPair } from "jose"
import {
  mintHostTunnelToken,
  mintRuntimeAccessToken,
} from "@claxedo/workspace-relay"
import { configureWorkspaceSupervisor, shutdownWorkspaceSupervisor } from "./workspace/supervisor"
import { configureEmbeddedWorkspaceRuntime } from "./deployments/local/embedded-workspace-runtime"
import { configureOpenCodeEngine, opencodeRequest } from "./opencode/engine"
import { ensureWorkspace } from "./workspace/store"
import { startUserHostedWorkspaceTunnel, stopAllUserHostedWorkspaceTunnels } from "./user-hosted-tunnel"
import { createApp } from "./deployments/local/server"
import { createControlPlaneServices } from "./control-plane/services"
import { createSqliteCentralStore } from "./control-plane/adapters/sqlite/central-store"

const execFileAsync = promisify(execFile)

let root = ""
let previousDataDir: string | undefined
let previousRelayHostPublicKey: string | undefined
let previousRelayJwtAlg: string | undefined

async function run(cwd: string, ...args: string[]) {
  await execFileAsync(args[0]!, args.slice(1), { cwd })
}

async function closeServer(server: { close(callback?: (err?: Error) => void): unknown }) {
  await Promise.race([
    new Promise<void>((resolve, reject) => {
      server.close((err?: Error) => err ? reject(err) : resolve())
    }),
    new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
  ])
}

async function forbiddenOpencodeServer() {
  const requests: string[] = []
  const server = createServer((req, res) => {
    requests.push(`${req.method ?? "GET"} ${req.url ?? "/"}`)
    res.writeHead(599, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "old opencode path should not be used" }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Forbidden OpenCode server did not bind")
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => closeServer(server),
  }
}

async function until<T>(fn: () => Promise<T | undefined>, ms = 20_000, step = 50): Promise<T> {
  const end = Date.now() + ms
  let err: unknown
  while (Date.now() < end) {
    try {
      const out = await fn()
      if (out !== undefined) return out
    } catch (next) {
      err = next
    }
    await new Promise((resolve) => setTimeout(resolve, step))
  }
  throw err instanceof Error ? err : new Error("Timed out")
}

async function waitForServerAddress(server: { address(): AddressInfo | string | null }) {
  return until(async () => {
    const address = server.address()
    return address && typeof address !== "string" ? address : undefined
  }, 1_000, 10)
}

async function waitForOpen(ws: WebSocket) {
  await new Promise<void>((resolve, reject) => {
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

async function startRelayFixture(input: {
  workspaceId: string
  hostId: string
  runtimePublicKeyJwk: JsonWebKey
  relayHostPrivateKeyJwk: JsonWebKey
}) {
  const logs: string[] = []
  const child = spawn("bun", ["src/user-hosted-relay-fixture.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLAXEDO_RELAY_FIXTURE_WORKSPACE_ID: input.workspaceId,
      CLAXEDO_RELAY_FIXTURE_HOST_ID: input.hostId,
      CLAXEDO_RELAY_FIXTURE_RUNTIME_PUBLIC_KEY_JWK: JSON.stringify(input.runtimePublicKeyJwk),
      CLAXEDO_RELAY_FIXTURE_HOST_PRIVATE_KEY_JWK: JSON.stringify(input.relayHostPrivateKeyJwk),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  return await new Promise<{
    url: string
    close: () => Promise<void>
  }>((resolve, reject) => {
    let settled = false
    let stdout = ""
    const fail = (err: Error) => {
      if (settled) return
      settled = true
      stopChild(child).finally(() => reject(err))
    }
    const timeout = setTimeout(() => {
      fail(new Error(`Workspace Relay fixture did not start\n${logs.join("")}`))
    }, 10_000)

    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString()
      logs.push(text)
      stdout += text
      for (const line of stdout.split("\n")) {
        if (settled || !line.trim()) continue
        try {
          const parsed = JSON.parse(line) as { url?: string }
          if (!parsed.url) continue
          settled = true
          clearTimeout(timeout)
          resolve({
            url: parsed.url.replace(/\/$/, ""),
            close: () => stopChild(child),
          })
        } catch {
          continue
        }
      }
    })
    child.stderr?.on("data", (chunk) => {
      logs.push(chunk.toString())
    })
    child.once("exit", (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(new Error(`Workspace Relay fixture exited before start (${code ?? signal})\n${logs.join("")}`))
    })
    child.once("error", fail)
  })
}

describe("server-owned user-hosted Workspace Relay tunnel E2E", () => {
  beforeEach(async () => {
    previousDataDir = process.env.CLAXEDO_DATA_DIR
    previousRelayHostPublicKey = process.env.CLAXEDO_RELAY_HOST_PUBLIC_KEY_JWK
    previousRelayJwtAlg = process.env.CLAXEDO_RELAY_JWT_ALG
    root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-user-hosted-e2e-"))
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
    process.env.CLAXEDO_RELAY_JWT_ALG = "EdDSA"
  })

  afterEach(async () => {
    stopAllUserHostedWorkspaceTunnels()
    await shutdownWorkspaceSupervisor()
    if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
    else process.env.CLAXEDO_DATA_DIR = previousDataDir
    if (previousRelayHostPublicKey === undefined) delete process.env.CLAXEDO_RELAY_HOST_PUBLIC_KEY_JWK
    else process.env.CLAXEDO_RELAY_HOST_PUBLIC_KEY_JWK = previousRelayHostPublicKey
    if (previousRelayJwtAlg === undefined) delete process.env.CLAXEDO_RELAY_JWT_ALG
    else process.env.CLAXEDO_RELAY_JWT_ALG = previousRelayJwtAlg
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
  })

  test("connects a host tunnel to the embedded local workspace-runtime and serves user-hosted relay traffic", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const opencode = await forbiddenOpencodeServer()
    process.env.CLAXEDO_RELAY_HOST_PUBLIC_KEY_JWK = JSON.stringify(await exportJWK(relayHost.publicKey))

    const workspaceDir = path.join(root, "workspace")
    await fs.mkdir(workspaceDir, { recursive: true })
    await run(workspaceDir, "git", "init", "-b", "main")
    await fs.writeFile(path.join(workspaceDir, "hello.txt"), "hello through relay\n")

    const ws = await ensureWorkspace({
      workspaceId: "ws_user_hosted_e2e",
      directory: workspaceDir,
      kind: "local",
      workspace_name: "User Hosted E2E",
    })
    expect(ws?.id).toBe("ws_user_hosted_e2e")

    configureOpenCodeEngine({ url: opencode.url })
    configureEmbeddedWorkspaceRuntime({ opencodeRequest })
    const centralStore = createSqliteCentralStore({ mode: () => "central_canonical" })
    const built = createApp(createControlPlaneServices({
      projectionStore: centralStore.projectionStore,
      durableSessionLog: centralStore.durableSessionLog,
    }))
    const controlPlane = serve({
      fetch: built.app.fetch,
      port: 0,
      hostname: "127.0.0.1",
    })
    built.injectWebSocket(controlPlane)
    const address = await waitForServerAddress(controlPlane)
    configureWorkspaceSupervisor({
      server_url: `http://127.0.0.1:${address.port}`,
      opencode_url: opencode.url,
    })

    const relay = await startRelayFixture({
      workspaceId: ws!.id,
      hostId: "host_user_hosted_e2e",
      runtimePublicKeyJwk: await exportJWK(runtime.publicKey),
      relayHostPrivateKeyJwk: await exportJWK(relayHost.privateKey),
    })
    let socket: WebSocket | undefined

    try {
      const hostTunnelToken = await mintHostTunnelToken({
        subject: "user_host",
        hostId: "host_user_hosted_e2e",
        workspaceIds: [ws!.id],
      }, runtime.privateKey, "EdDSA")
      const started = await startUserHostedWorkspaceTunnel({
        workspaceId: ws!.id,
        hostId: "host_user_hosted_e2e",
        relayUrl: relay.url,
        hostTunnelToken,
      })

      const runtimeAccessToken = await mintRuntimeAccessToken({
        subject: "user_viewer",
        orgId: "org_1",
        workspaceId: ws!.id,
        hostId: "host_user_hosted_e2e",
        role: "editor",
      }, runtime.privateKey, "EdDSA")

      const embeddedHealth = await fetch(`${started.url}/api/wr/health`, {
        headers: {
          "x-workspace-id": ws!.id,
        },
      })
      expect(embeddedHealth.status).toBe(200)
      const embeddedHealthBody = await embeddedHealth.json() as Record<string, unknown>
      expect(embeddedHealthBody).toMatchObject({ service: "workspace-runtime" })
      expect(embeddedHealthBody).not.toHaveProperty("workspaceId")

      const relayFetch = (route: string) =>
        fetch(`${relay.url}/workspaces/${ws!.id}${route}`, {
          headers: {
            authorization: `Bearer ${runtimeAccessToken}`,
          },
        })

      const health = await until(async () => {
        const response = await relayFetch("/api/wr/health")
        return response.status === 200 ? response : undefined
      })
      expect(health.status).toBe(200)
      const healthBody = await health.json() as Record<string, unknown>
      expect(healthBody).toMatchObject({ service: "workspace-runtime" })
      expect(healthBody).not.toHaveProperty("workspaceId")

      const raw = await relayFetch("/file/raw?path=hello.txt")
      expect(raw.status).toBe(200)
      await expect(raw.text()).resolves.toBe("hello through relay\n")

      const pty = await fetch(`${relay.url}/workspaces/${ws!.id}/api/wr/pty`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${runtimeAccessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "/bin/cat",
          args: [],
          cwd: ".",
        }),
      })
      expect(pty.status).toBe(200)
      const info = await pty.json() as { id: string }
      socket = new (WebSocket as unknown as {
        new(url: string, options: { headers: Record<string, string>; protocols: string[] }): WebSocket
      })(
        `${relay.url}/workspaces/${ws!.id}/api/wr/pty/${encodeURIComponent(info.id)}/connect?cursor=0`
          .replace(/^http/, "ws"),
        {
          headers: { origin: "http://localhost:3000" },
          protocols: [`claxedo-rat.${runtimeAccessToken}`],
        },
      )
      socket.binaryType = "arraybuffer"
      await waitForOpen(socket)
      await waitForMessage(socket, (message) => message.startsWith("\0") && message.includes("\"cursor\""))
      const removePty = await fetch(
        `${relay.url}/workspaces/${ws!.id}/api/wr/pty/${encodeURIComponent(info.id)}`,
        {
          method: "DELETE",
          headers: {
            authorization: `Bearer ${runtimeAccessToken}`,
          },
        },
      )
      expect(removePty.status).toBe(200)

      expect(opencode.requests).toEqual([])
    } finally {
      socket?.close()
      stopAllUserHostedWorkspaceTunnels()
      await relay.close()
      await closeServer(controlPlane)
      await opencode.close()
    }
  }, 30_000)
})
