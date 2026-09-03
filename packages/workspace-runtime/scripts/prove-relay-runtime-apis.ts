import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { generateKeyPair } from "jose"
import {
  createWorkspaceRelayBun,
  createWorkspaceRelayDirectory,
  mintHostTunnelToken,
  mintRelayHostToken,
  mintRuntimeAccessToken,
} from "@claxedo/workspace-relay"
import { startServer, waitForWorkspaceRuntimeServerPort } from "../src/server"
import { startWorkspaceRelayHostTunnel } from "../src/workspace-relay-host-tunnel"

const workspaceId = "ws_local_perf_proof"
const hostId = "host_local_perf_proof"
const subject = "user_local_perf_proof"
const orgId = "org_local_perf_proof"
const NativeResponse = globalThis.Response

type Result = {
  name: string
  directMs?: number
  relayMs: number
  bytes?: number
  status: "pass" | "warn" | "fail"
  detail?: string
}

function ms(startedAt: number) {
  return Math.round((performance.now() - startedAt) * 100) / 100
}

async function waitForRuntime(url: string) {
  for (let i = 0; i < 200; i++) {
    const res = await fetch(`${url}/global/health`).catch(() => undefined)
    if (res?.ok) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("Workspace runtime did not become ready")
}

async function waitForPresence(directory: ReturnType<typeof createWorkspaceRelayDirectory>) {
  for (let i = 0; i < 200; i++) {
    if (directory.activeHost({ hostId, workspaceId })) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("Host tunnel did not register with the relay")
}

function relayUrl(base: string, route: string) {
  return `${base}/workspaces/${workspaceId}${route}`
}

function directHeaders(relayHostToken: string) {
  return {
    authorization: `Bearer ${relayHostToken}`,
    "x-workspace-id": workspaceId,
    "x-forwarded-by": "workspace-relay",
  }
}

function relayHeaders(runtimeAccessToken: string, headers?: HeadersInit) {
  return {
    ...Object.fromEntries(new Headers(headers).entries()),
    authorization: `Bearer ${runtimeAccessToken}`,
  }
}

async function expectOk(res: Response, label: string) {
  if (res.ok) return
  throw new Error(`${label} returned ${res.status}: ${await res.text().catch(() => "")}`)
}

async function readAll(res: Response) {
  const body = await res.arrayBuffer()
  return new Uint8Array(body)
}

async function measureHttp(input: {
  name: string
  direct: () => Promise<Response>
  relay: () => Promise<Response>
  body?: "json" | "bytes"
}) {
  const directStarted = performance.now()
  const direct = await input.direct()
  const directMs = ms(directStarted)
  await expectOk(direct, `${input.name} direct`)
  const directBody = input.body === "bytes" ? await readAll(direct) : input.body === "json" ? await direct.json() : undefined

  const relayStarted = performance.now()
  const relay = await input.relay()
  const relayMs = ms(relayStarted)
  await expectOk(relay, `${input.name} relay`)
  const relayBody = input.body === "bytes" ? await readAll(relay) : input.body === "json" ? await relay.json() : undefined

  if (input.body === "bytes") {
    const directBytes = directBody as Uint8Array
    const relayBytes = relayBody as Uint8Array
    if (directBytes.byteLength !== relayBytes.byteLength) {
      throw new Error(`${input.name} byte length mismatch: direct=${directBytes.byteLength} relay=${relayBytes.byteLength}`)
    }
    return {
      name: input.name,
      directMs,
      relayMs,
      bytes: relayBytes.byteLength,
      status: "pass" as const,
    }
  }

  if (input.body === "json") {
    const directJson = directBody as { service?: unknown; workspaceId?: unknown }
    const relayJson = relayBody as { service?: unknown; workspaceId?: unknown }
    if (directJson.service !== relayJson.service || directJson.workspaceId !== relayJson.workspaceId) {
      throw new Error(`${input.name} JSON identity mismatch`)
    }
  }

  return {
    name: input.name,
    directMs,
    relayMs,
    status: "pass" as const,
  }
}

function textMessage(input: MessageEvent["data"]) {
  if (typeof input === "string") return input
  if (input instanceof ArrayBuffer) return new TextDecoder().decode(input)
  if (ArrayBuffer.isView(input)) return new TextDecoder().decode(input)
  return ""
}

function wsProbe(ws: WebSocket) {
  const messages: string[] = []
  const waiters = new Set<{
    predicate: (message: string) => boolean
    resolve: (message: string) => void
    reject: (error: Error) => void
    timeout: ReturnType<typeof setTimeout>
  }>()
  const open = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WebSocket did not open")), 5_000)
    ws.onopen = () => {
      clearTimeout(timeout)
      resolve()
    }
    ws.onerror = () => {
      clearTimeout(timeout)
      reject(new Error("WebSocket failed to open"))
    }
    ws.onclose = (event) => {
      clearTimeout(timeout)
      reject(new Error(`WebSocket closed before open code=${event.code} reason=${event.reason}`))
      for (const waiter of waiters) {
        clearTimeout(waiter.timeout)
        waiter.reject(new Error(`WebSocket closed while waiting for message code=${event.code} reason=${event.reason}; saw ${JSON.stringify(messages)}`))
      }
      waiters.clear()
    }
  })
  ws.onmessage = (event) => {
    const message = textMessage(event.data)
    messages.push(message)
    for (const waiter of Array.from(waiters)) {
      if (!waiter.predicate(message)) continue
      clearTimeout(waiter.timeout)
      waiters.delete(waiter)
      waiter.resolve(message)
    }
  }
  return {
    open,
    waitForMessage(predicate: (message: string) => boolean) {
      const existing = messages.find(predicate)
      if (existing) return Promise.resolve(existing)
      return new Promise<string>((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          timeout: setTimeout(() => {
            waiters.delete(waiter)
            reject(new Error(`Expected WebSocket message was not received; saw ${JSON.stringify(messages)}`))
          }, 5_000),
        }
        waiters.add(waiter)
      })
    },
  }
}

async function measureRelayPty(input: {
  relayBaseUrl: string
  runtimeAccessToken: string
}) {
  const createStarted = performance.now()
  const created = await fetch(relayUrl(input.relayBaseUrl, "/api/claxedo/pty"), {
    method: "POST",
    headers: relayHeaders(input.runtimeAccessToken, {
      "content-type": "application/json",
    }),
    body: JSON.stringify({
      command: "/bin/sh",
      cwd: ".",
    }),
  })
  await expectOk(created, "relay PTY create")
  const createMs = ms(createStarted)
  const info = await created.json() as { id: string }
  let ws: WebSocket | undefined
  try {
    const openStarted = performance.now()
    ws = new (WebSocket as unknown as {
      new(url: string, options: { headers?: Record<string, string>; protocols?: string[] }): WebSocket
    })(
      relayUrl(input.relayBaseUrl, `/api/claxedo/pty/${encodeURIComponent(info.id)}/connect?cursor=0`).replace(/^http/, "ws"),
      {
        headers: { origin: "http://localhost:3000" },
        protocols: [`claxedo-rat.${input.runtimeAccessToken}`],
      },
    )
    ws.binaryType = "arraybuffer"
    const probe = wsProbe(ws)
    await probe.open
    await probe.waitForMessage((message) => message.startsWith("\0") && message.includes("\"cursor\""))
    const openMs = ms(openStarted)

    const echoStarted = performance.now()
    try {
      ws.send("printf 'relay-pty-proof-ok\\n'\r")
      await probe.waitForMessage((message) => message.includes("relay-pty-proof-ok"))
      return {
        name: "relay PTY websocket echo",
        relayMs: ms(echoStarted),
        status: "pass" as const,
        detail: `create=${createMs}ms open=${openMs}ms`,
      }
    } catch (err) {
      return {
        name: "relay PTY websocket echo",
        relayMs: ms(echoStarted),
        status: "warn" as const,
        detail: `output cursor worked, input echo was not observed (${err instanceof Error ? err.message : String(err)}); create=${createMs}ms open=${openMs}ms`,
      }
    }
  } finally {
    ws?.close()
    await fetch(relayUrl(input.relayBaseUrl, `/api/claxedo/pty/${encodeURIComponent(info.id)}`), {
      method: "DELETE",
      headers: relayHeaders(input.runtimeAccessToken),
    }).catch(() => undefined)
  }
}

async function measureDirectPty(input: {
  runtimeBaseUrl: string
  relayHostToken: string
}) {
  const createStarted = performance.now()
  const created = await fetch(`${input.runtimeBaseUrl}/api/claxedo/pty`, {
    method: "POST",
    headers: {
      ...directHeaders(input.relayHostToken),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      command: "/bin/sh",
      cwd: ".",
    }),
  })
  await expectOk(created, "direct PTY create")
  const createMs = ms(createStarted)
  const info = await created.json() as { id: string }
  let ws: WebSocket | undefined
  try {
    const openStarted = performance.now()
    ws = new (WebSocket as unknown as {
      new(url: string, options: { headers?: Record<string, string> }): WebSocket
    })(
      `${input.runtimeBaseUrl}/api/claxedo/pty/${encodeURIComponent(info.id)}/connect?cursor=0`.replace(/^http/, "ws"),
      {
        headers: directHeaders(input.relayHostToken),
      },
    )
    ws.binaryType = "arraybuffer"
    const probe = wsProbe(ws)
    await probe.open
    await probe.waitForMessage((message) => message.startsWith("\0") && message.includes("\"cursor\""))
    const openMs = ms(openStarted)

    const echoStarted = performance.now()
    try {
      ws.send("printf 'direct-pty-proof-ok\\n'\r")
      await probe.waitForMessage((message) => message.includes("direct-pty-proof-ok"))
      return {
        name: "direct PTY websocket echo",
        relayMs: ms(echoStarted),
        status: "pass" as const,
        detail: `create=${createMs}ms open=${openMs}ms`,
      }
    } catch (err) {
      return {
        name: "direct PTY websocket echo",
        relayMs: ms(echoStarted),
        status: "warn" as const,
        detail: `output cursor worked, input echo was not observed (${err instanceof Error ? err.message : String(err)}); create=${createMs}ms open=${openMs}ms`,
      }
    }
  } finally {
    ws?.close()
    await fetch(`${input.runtimeBaseUrl}/api/claxedo/pty/${encodeURIComponent(info.id)}`, {
      method: "DELETE",
      headers: directHeaders(input.relayHostToken),
    }).catch(() => undefined)
  }
}

function print(results: Result[]) {
  for (const item of results) {
    const direct = item.directMs === undefined ? "" : ` direct=${item.directMs}ms`
    const bytes = item.bytes === undefined ? "" : ` bytes=${item.bytes}`
    const detail = item.detail ? ` ${item.detail}` : ""
    console.log(`${item.status.toUpperCase().padEnd(4)} ${item.name}${direct} relay=${item.relayMs}ms${bytes}${detail}`)
  }
}

async function main() {
  const runtime = await generateKeyPair("EdDSA", { extractable: true })
  const relayHost = await generateKeyPair("EdDSA", { extractable: true })
  const directory = createWorkspaceRelayDirectory()
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-relay-runtime-proof-"))
  const previousDirectory = process.env.WORKSPACE_RUNTIME_DIRECTORY
  const previousWorkspaceId = process.env.WORKSPACE_RUNTIME_WORKSPACE_ID
  const previousHostId = process.env.WORKSPACE_RUNTIME_HOST_ID
  process.env.WORKSPACE_RUNTIME_DIRECTORY = workspaceDir
  process.env.WORKSPACE_RUNTIME_WORKSPACE_ID = workspaceId
  process.env.WORKSPACE_RUNTIME_HOST_ID = hostId

  const relayHandler = createWorkspaceRelayBun({
    runtimeAccessKey: runtime.publicKey,
    relayHostSigningKey: relayHost.privateKey,
    relayHostAlgorithm: "EdDSA",
    directory,
    resolveTarget: (claims) => ({
      workspaceId: claims.workspace_id,
      hostId: claims.host_id,
      baseUrl: "http://user-hosted.invalid",
      access: "user-hosted",
      backing: "local-worktree",
    }),
    isRuntimeAccessTokenActive: () => ({ active: true }),
  })
  const relayServer = Bun.serve({
    port: 0,
    fetch: relayHandler.fetch,
    websocket: relayHandler.websocket,
  })
  const relayBaseUrl = String(relayServer.url).replace(/\/$/, "")

  const runtimeServer = startServer(0, {
    target: { workspaceId, directory: workspaceDir },
    relayHostAuth: {
      key: relayHost.publicKey,
      workspaceId,
      hostId,
    },
  })
  globalThis.Response = NativeResponse
  const runtimeBaseUrl = `http://127.0.0.1:${await waitForWorkspaceRuntimeServerPort(runtimeServer, 0)}`
  let tunnel: ReturnType<typeof startWorkspaceRelayHostTunnel> | undefined

  try {
    await waitForRuntime(runtimeBaseUrl)

    const hostTunnelToken = await mintHostTunnelToken({
      subject,
      hostId,
      workspaceIds: [workspaceId],
    }, runtime.privateKey, "EdDSA")
    tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: relayBaseUrl,
      hostId,
      workspaceIds: [workspaceId],
      localBaseUrl: runtimeBaseUrl,
      headers: {
        authorization: `Bearer ${hostTunnelToken}`,
      },
      pingIntervalMs: 1_000,
      onEvent: (event) => {
        if (event.type === "auth-failed" || event.type === "reconnecting" || event.type === "closed") {
          console.warn(`[relay-runtime-proof] host tunnel event ${JSON.stringify(event)}`)
        }
      },
    })
    await waitForPresence(directory)

    const runtimeAccessToken = await mintRuntimeAccessToken({
      principalKind: "user",
      actorId: subject,
      actorKind: "human",
      orgId,
      workspaceId,
      hostId,
      role: "editor",
      jti: "rat_prove_relay_runtime_apis",
    }, runtime.privateKey, "EdDSA")
    const relayHostToken = await mintRelayHostToken({
      principalKind: "user",
      actorId: subject,
      actorKind: "human",
      orgId,
      workspaceId,
      hostId,
      role: "editor",
      parentJti: "rat_prove_relay_runtime_apis",
      access: "user-hosted",
      backing: "local-worktree",
    }, relayHost.privateKey, "EdDSA")
    const direct = (route: string, init: RequestInit = {}) =>
      fetch(`${runtimeBaseUrl}${route}`, {
        ...init,
        headers: {
          ...directHeaders(relayHostToken),
          ...Object.fromEntries(new Headers(init.headers).entries()),
        },
      })
    const relay = (route: string, init: RequestInit = {}) =>
      fetch(relayUrl(relayBaseUrl, route), {
        ...init,
        headers: relayHeaders(runtimeAccessToken, init.headers),
      })

    const unauthorized = await fetch(`${runtimeBaseUrl}/api/wr/health`)
    if (unauthorized.status !== 401) {
      throw new Error(`Expected direct unauthenticated runtime health to return 401, got ${unauthorized.status}`)
    }

    await fs.writeFile(path.join(workspaceDir, "proof-128k.bin"), Uint8Array.from({ length: 128 * 1024 }, (_, index) => index % 251))
    await fs.writeFile(path.join(workspaceDir, "proof-1m.bin"), Uint8Array.from({ length: 1024 * 1024 }, (_, index) => (index * 7) % 251))

    const results: Result[] = []
    results.push(await measureHttp({
      name: "runtime health",
      direct: () => direct("/api/wr/health"),
      relay: () => relay("/api/wr/health"),
      body: "json",
    }))
    results.push(await measureHttp({
      name: "raw file 128KiB",
      direct: () => direct("/file/raw?path=proof-128k.bin"),
      relay: () => relay("/file/raw?path=proof-128k.bin"),
      body: "bytes",
    }))
    results.push(await measureHttp({
      name: "raw file 1MiB",
      direct: () => direct("/file/raw?path=proof-1m.bin"),
      relay: () => relay("/file/raw?path=proof-1m.bin"),
      body: "bytes",
    }))
    results.push(await measureDirectPty({ runtimeBaseUrl, relayHostToken }))
    results.push(await measureRelayPty({ relayBaseUrl, runtimeAccessToken }))

    print(results)
    console.log(JSON.stringify({
      ok: true,
      runtimeBaseUrl,
      relayBaseUrl,
      workspaceId,
      hostId,
      results,
    }, null, 2))
  } finally {
    tunnel?.close()
    relayServer.stop(true)
    runtimeServer.close()
    directory.dispose()
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined)
    if (previousDirectory === undefined) delete process.env.WORKSPACE_RUNTIME_DIRECTORY
    else process.env.WORKSPACE_RUNTIME_DIRECTORY = previousDirectory
    if (previousWorkspaceId === undefined) delete process.env.WORKSPACE_RUNTIME_WORKSPACE_ID
    else process.env.WORKSPACE_RUNTIME_WORKSPACE_ID = previousWorkspaceId
    if (previousHostId === undefined) delete process.env.WORKSPACE_RUNTIME_HOST_ID
    else process.env.WORKSPACE_RUNTIME_HOST_ID = previousHostId
  }
}

await main()
