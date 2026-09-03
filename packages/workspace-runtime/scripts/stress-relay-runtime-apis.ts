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

const workspaceId = "ws_local_stress"
const hostId = "host_local_stress"
const subject = "user_local_stress"
const orgId = "org_local_stress"
const NativeResponse = globalThis.Response

type BatchResult = {
  name: string
  target: "direct" | "relay"
  requests: number
  concurrency: number
  ok: number
  failed: number
  totalMs: number
  rps: number
  bytes: number
  mbps: number
  minMs?: number
  p50Ms?: number
  p90Ms?: number
  p95Ms?: number
  p99Ms?: number
  maxMs?: number
  errors: string[]
}

type StressResult = {
  generatedAt: string
  runtimeBaseUrl: string
  relayBaseUrl: string
  workspaceId: string
  hostId: string
  config: {
    healthRequests: number
    healthConcurrency: number
    fileRequests: number
    fileConcurrency: number
    fileSizeBytes: number
    timeoutMs: number
  }
  batches: BatchResult[]
}

function optionValue(args: string[], name: string) {
  const inline = args.find((arg) => arg.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1).trim() || undefined
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]?.trim()
  return value && !value.startsWith("--") ? value : undefined
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function percentile(sorted: number[], p: number) {
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(Math.max(rank - 1, 0), sorted.length - 1)]
}

function round(value: number) {
  return Math.round(value * 100) / 100
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

async function requestWithTimeout(input: {
  url: string
  init?: RequestInit
  timeoutMs: number
}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs)
  const startedAt = performance.now()
  try {
    const res = await fetch(input.url, {
      ...input.init,
      signal: controller.signal,
    })
    const body = await res.arrayBuffer()
    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText}: ${new TextDecoder().decode(body).slice(0, 200)}`)
    }
    return {
      ms: performance.now() - startedAt,
      bytes: body.byteLength,
    }
  } finally {
    clearTimeout(timer)
  }
}

async function runBatch(input: {
  name: string
  target: "direct" | "relay"
  requests: number
  concurrency: number
  task: () => Promise<{ ms: number; bytes: number }>
}) {
  const samples: number[] = []
  const errors: string[] = []
  let bytes = 0
  let next = 0
  const startedAt = performance.now()

  await Promise.all(Array.from({ length: input.concurrency }, async () => {
    while (true) {
      const index = next++
      if (index >= input.requests) return
      try {
        const result = await input.task()
        samples.push(result.ms)
        bytes += result.bytes
      } catch (err) {
        if (errors.length < 10) errors.push(err instanceof Error ? err.message : String(err))
      }
    }
  }))

  const totalMs = performance.now() - startedAt
  const sorted = samples.sort((a, b) => a - b)
  const seconds = Math.max(totalMs / 1000, 0.001)
  return {
    name: input.name,
    target: input.target,
    requests: input.requests,
    concurrency: input.concurrency,
    ok: sorted.length,
    failed: input.requests - sorted.length,
    totalMs: round(totalMs),
    rps: round(sorted.length / seconds),
    bytes,
    mbps: round((bytes / 1024 / 1024) / seconds),
    ...(sorted.length ? {
      minMs: round(sorted[0]),
      p50Ms: round(percentile(sorted, 50)),
      p90Ms: round(percentile(sorted, 90)),
      p95Ms: round(percentile(sorted, 95)),
      p99Ms: round(percentile(sorted, 99)),
      maxMs: round(sorted[sorted.length - 1]),
    } : {}),
    errors,
  } satisfies BatchResult
}

function printBatch(item: BatchResult) {
  const stats = item.ok
    ? `min=${item.minMs} p50=${item.p50Ms} p90=${item.p90Ms} p95=${item.p95Ms} p99=${item.p99Ms} max=${item.maxMs}`
    : "no successful samples"
  console.log([
    item.failed ? "FAIL" : "PASS",
    `${item.name}.${item.target}`,
    `ok=${item.ok}/${item.requests}`,
    `c=${item.concurrency}`,
    `total=${item.totalMs}ms`,
    `rps=${item.rps}`,
    `mbps=${item.mbps}`,
    stats,
  ].join(" "))
  for (const error of item.errors) console.log(`  error: ${error}`)
}

async function main() {
  const args = process.argv.slice(2)
  const healthRequests = positiveInteger(optionValue(args, "--health-requests") ?? process.env.CLAXEDO_STRESS_HEALTH_REQUESTS, 200)
  const healthConcurrency = positiveInteger(optionValue(args, "--health-concurrency") ?? process.env.CLAXEDO_STRESS_HEALTH_CONCURRENCY, 25)
  const fileRequests = positiveInteger(optionValue(args, "--file-requests") ?? process.env.CLAXEDO_STRESS_FILE_REQUESTS, 80)
  const fileConcurrency = positiveInteger(optionValue(args, "--file-concurrency") ?? process.env.CLAXEDO_STRESS_FILE_CONCURRENCY, 10)
  const fileSizeBytes = positiveInteger(optionValue(args, "--file-size-bytes") ?? process.env.CLAXEDO_STRESS_FILE_SIZE_BYTES, 2 * 1024 * 1024)
  const timeoutMs = positiveInteger(optionValue(args, "--timeout-ms") ?? process.env.CLAXEDO_STRESS_TIMEOUT_MS, 15_000)
  const manifest = optionValue(args, "--manifest") ?? process.env.CLAXEDO_STRESS_MANIFEST

  const runtime = await generateKeyPair("EdDSA", { extractable: true })
  const relayHost = await generateKeyPair("EdDSA", { extractable: true })
  const directory = createWorkspaceRelayDirectory()
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-relay-runtime-stress-"))
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
      jti: "rat_stress_relay_runtime_apis",
    }, runtime.privateKey, "EdDSA")
    const relayHostToken = await mintRelayHostToken({
      principalKind: "user",
      actorId: subject,
      actorKind: "human",
      orgId,
      workspaceId,
      hostId,
      role: "editor",
      parentJti: "rat_stress_relay_runtime_apis",
      access: "user-hosted",
      backing: "local-worktree",
    }, relayHost.privateKey, "EdDSA")
    const direct = (route: string, init: RequestInit = {}) => ({
      url: `${runtimeBaseUrl}${route}`,
      init: {
        ...init,
        headers: {
          ...directHeaders(relayHostToken),
          ...Object.fromEntries(new Headers(init.headers).entries()),
        },
      },
    })
    const relay = (route: string, init: RequestInit = {}) => ({
      url: relayUrl(relayBaseUrl, route),
      init: {
        ...init,
        headers: relayHeaders(runtimeAccessToken, init.headers),
      },
    })

    await fs.writeFile(path.join(workspaceDir, "stress.bin"), Uint8Array.from({ length: fileSizeBytes }, (_, index) => (index * 31) % 251))

    const warmups = [
      direct("/api/wr/health"),
      relay("/api/wr/health"),
      direct("/file/raw?path=stress.bin"),
      relay("/file/raw?path=stress.bin"),
    ]
    await Promise.all(warmups.map((item) => requestWithTimeout({ ...item, timeoutMs })))

    const batches = [
      await runBatch({
        name: "health",
        target: "direct",
        requests: healthRequests,
        concurrency: healthConcurrency,
        task: () => requestWithTimeout({ ...direct("/api/wr/health"), timeoutMs }),
      }),
      await runBatch({
        name: "health",
        target: "relay",
        requests: healthRequests,
        concurrency: healthConcurrency,
        task: () => requestWithTimeout({ ...relay("/api/wr/health"), timeoutMs }),
      }),
      await runBatch({
        name: "raw-file",
        target: "direct",
        requests: fileRequests,
        concurrency: fileConcurrency,
        task: () => requestWithTimeout({ ...direct("/file/raw?path=stress.bin"), timeoutMs }),
      }),
      await runBatch({
        name: "raw-file",
        target: "relay",
        requests: fileRequests,
        concurrency: fileConcurrency,
        task: () => requestWithTimeout({ ...relay("/file/raw?path=stress.bin"), timeoutMs }),
      }),
    ]

    for (const batch of batches) printBatch(batch)

    const result: StressResult = {
      generatedAt: new Date().toISOString(),
      runtimeBaseUrl,
      relayBaseUrl,
      workspaceId,
      hostId,
      config: {
        healthRequests,
        healthConcurrency,
        fileRequests,
        fileConcurrency,
        fileSizeBytes,
        timeoutMs,
      },
      batches,
    }
    if (manifest) {
      await fs.mkdir(path.dirname(manifest), { recursive: true }).catch(() => undefined)
      await fs.writeFile(manifest, `${JSON.stringify(result, null, 2)}\n`)
      console.log(`Wrote manifest ${manifest}`)
    }
    console.log(JSON.stringify(result, null, 2))
    if (batches.some((batch) => batch.failed > 0)) process.exitCode = 1
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
