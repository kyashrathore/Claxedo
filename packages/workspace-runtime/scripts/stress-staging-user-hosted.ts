import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createPrivateKey, generateKeyPairSync, sign as signData } from "node:crypto"
import { ConvexHttpClient } from "convex/browser"
import { importPKCS8 } from "jose"
import { mintRuntimeAccessToken } from "@claxedo/workspace-relay"
import { api } from "../../../convex/_generated/api.js"
import { loadRelayHostVerificationKeyOrJwks } from "../src/workspace-host-service-auth"
import { startServer, waitForWorkspaceRuntimeServerPort } from "../src/server"
import { startWorkspaceRelayHostTunnel } from "../src/workspace-relay-host-tunnel"

type Env = Record<string, string | undefined>
type BatchResult = {
  name: string
  target: "direct" | "staging-relay"
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

const NativeResponse = globalThis.Response

function clean(input: string | undefined) {
  const value = input?.trim()
  return value ? value : undefined
}

function optionValue(args: string[], name: string) {
  const inline = args.find((arg) => arg.startsWith(`${name}=`))
  if (inline) return clean(inline.slice(name.length + 1))
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = clean(args[index + 1])
  return value?.startsWith("--") ? undefined : value
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(clean(value))
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

async function loadEnv(file: string) {
  const parsed: Env = {}
  for (const line of (await fs.readFile(file, "utf8")).split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!match) continue
    parsed[match[1]] = match[2]?.trim().replace(/^['"]|['"]$/g, "")
  }
  return { ...parsed, ...process.env }
}

function requireEnv(env: Env, key: string) {
  const value = clean(env[key])
  if (!value) throw new Error(`${key} is required`)
  return value
}

function pem(input: string) {
  return input.replaceAll("\\n", "\n")
}

async function clerk(env: Env, path: string, init: RequestInit = {}) {
  return await fetch(`https://api.clerk.com/v1${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${requireEnv(env, "CLERK_SECRET_KEY")}`,
      ...Object.fromEntries(new Headers(init.headers).entries()),
    },
  })
}

async function createSessionToken(env: Env) {
  const userId = clean(env.CLAXEDO_STRESS_CLERK_USER_ID)
    ?? ((await (await clerk(env, "/users?limit=1")).json()) as Array<{ id: string }>)[0]?.id
  if (!userId) throw new Error("No Clerk user found for staging stress")
  const session = await (await clerk(env, "/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user_id: userId }),
  })).json() as { id?: string }
  if (!session.id) throw new Error("Clerk session creation did not return an id")
  const template = clean(env.CLAXEDO_STRESS_CLERK_TOKEN_TEMPLATE) ?? "convex"
  const token = await (await clerk(env, `/sessions/${encodeURIComponent(session.id)}/tokens/${encodeURIComponent(template)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expires_in_seconds: 900 }),
  })).json() as { jwt?: string }
  if (!token.jwt) throw new Error("Clerk session token creation did not return a JWT")
  return { sessionId: session.id, token: token.jwt }
}

function route(base: string, path: string) {
  return new URL(path.replace(/^\/+/, ""), base.endsWith("/") ? base : `${base}/`).toString()
}

async function expectJson<T>(res: Response, label: string) {
  const text = await res.text()
  if (res.ok) return JSON.parse(text) as T
  throw new Error(`${label} returned ${res.status}: ${text.slice(0, 500)}`)
}

function base64url(input: Buffer) {
  return input.toString("base64url")
}

function registrationPayload(input: {
  workspaceId: string
  hostId: string
  challengeId: string
  nonce: string
}) {
  return [
    "claxedo.local-host-link.register.v1",
    `workspace_id=${input.workspaceId}`,
    `host_id=${input.hostId}`,
    `challenge_id=${input.challengeId}`,
    `nonce=${input.nonce}`,
  ].join("\n")
}

async function registerUserHosted(input: {
  env: Env
  token: string
  workspaceId: string
  hostId: string
  displayName: string
}) {
  const centralUrl = requireEnv(input.env, "CLAXEDO_CENTRAL_URL")
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" })
  const publicKey = JSON.stringify(pair.publicKey.export({ format: "jwk" }))
  const challenge = await expectJson<{
    challenge?: { challengeId?: string; nonce?: string }
  }>(await fetch(route(centralUrl, `/api/workspace/${encodeURIComponent(input.workspaceId)}/user-hosted/challenge`), {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      hostId: input.hostId,
      displayName: input.displayName,
    }),
  }), "user-hosted challenge")
  const challengeId = challenge.challenge?.challengeId
  const nonce = challenge.challenge?.nonce
  if (!challengeId || !nonce) throw new Error("Challenge response was missing challengeId/nonce")

  const signature = base64url(signData("sha256", Buffer.from(registrationPayload({
    workspaceId: input.workspaceId,
    hostId: input.hostId,
    challengeId,
    nonce,
  })), {
    key: createPrivateKey({ key: pair.privateKey.export({ format: "jwk" }), format: "jwk" }),
    dsaEncoding: "ieee-p1363",
  }))
  return await expectJson<{
    workspace?: { workspace_id?: string; home_region?: string }
    hostTunnel?: { hostTunnelToken?: string; relayUrl?: string; tokenExpiresAt?: number }
  }>(await fetch(route(centralUrl, `/api/workspace/${encodeURIComponent(input.workspaceId)}/user-hosted/register`), {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      hostId: input.hostId,
      publicKey,
      challengeId,
      signature,
      displayName: input.displayName,
      ttlMs: 300_000,
      remoteDirectory: "staging-stress",
    }),
  }), "user-hosted register")
}

async function waitForRuntime(url: string) {
  for (let i = 0; i < 200; i++) {
    const res = await fetch(`${url}/global/health`).catch(() => undefined)
    if (res?.ok) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("Workspace runtime did not become ready")
}

async function waitForConnection(input: {
  centralUrl: string
  token: string
  workspaceId: string
}) {
  let last = "no response"
  for (let i = 0; i < 20; i++) {
    const res = await fetch(route(input.centralUrl, `/api/workspace/${encodeURIComponent(input.workspaceId)}/connection`), {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json",
      },
      body: "{}",
    })
    const text = await res.text()
    last = `${res.status}: ${text.slice(0, 500)}`
    const body = (() => {
      try {
        return JSON.parse(text) as {
          status?: string
          runtimeAccessToken?: string
          relayUrl?: string
          workspaceId?: string
          hostId?: string
          homeRegion?: string
        }
      } catch {
        return undefined
      }
    })()
    const parsed = body as {
      status?: string
      runtimeAccessToken?: string
      relayUrl?: string
      workspaceId?: string
      hostId?: string
      homeRegion?: string
    } | undefined
    if (res.ok && parsed?.runtimeAccessToken && parsed.relayUrl) return parsed
    const retryAfterMs = typeof (parsed as { error?: { retryAfterMs?: unknown } } | undefined)?.error?.retryAfterMs === "number"
      ? (parsed as { error: { retryAfterMs: number } }).error.retryAfterMs
      : undefined
    await new Promise((resolve) =>
      setTimeout(resolve, retryAfterMs ? Math.min(Math.max(retryAfterMs, 1_000), 60_000) : parsed?.status === "provisioning" ? 2_000 : 2_500)
    )
  }
  throw new Error(`Staging workspace connection did not become ready; last=${last}`)
}

async function mintAndRecordRuntimeAccessToken(input: {
  env: Env
  authToken: string
  workspaceId: string
  hostId: string
}) {
  const ttlSeconds = 900
  const jti = `stress_${crypto.randomUUID().replace(/-/g, "")}`
  const expiresAt = Date.now() + ttlSeconds * 1000
  const alg = clean(input.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM)
  const algorithm = alg === "ES256" || alg === "RS256" || alg === "EdDSA" ? alg : "EdDSA"
  const privateKey = await importPKCS8(
    pem(requireEnv(input.env, "CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM")),
    algorithm,
  )
  const runtimeAccessToken = await mintRuntimeAccessToken({
    subject: "staging-stress",
    orgId: "org_staging_stress",
    workspaceId: input.workspaceId,
    hostId: input.hostId,
    role: "editor",
    ttlSeconds,
    jti,
  }, privateKey, algorithm)
  const client = new ConvexHttpClient(requireEnv(input.env, "CLAXEDO_WORKSPACE_AUTHORITY_URL"))
  client.setAuth(input.authToken)
  await client.mutation(api.runtimeAccessTokens.recordMint, {
    jti,
    workspace_id: input.workspaceId,
    host_id: input.hostId,
    expires_at: expiresAt,
  })
  return { runtimeAccessToken, tokenExpiresAt: expiresAt, jti }
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
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${new TextDecoder().decode(body).slice(0, 200)}`)
    return { ms: performance.now() - startedAt, bytes: body.byteLength }
  } finally {
    clearTimeout(timer)
  }
}

function percentile(sorted: number[], p: number) {
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(Math.max(rank - 1, 0), sorted.length - 1)]
}

function round(value: number) {
  return Math.round(value * 100) / 100
}

async function runBatch(input: {
  name: string
  target: "direct" | "staging-relay"
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
  const env = await loadEnv(optionValue(args, "--env-file") ?? "packages/claxedo-server/.env.local")
  const healthRequests = positiveInteger(optionValue(args, "--health-requests") ?? env.CLAXEDO_STRESS_HEALTH_REQUESTS, 200)
  const healthConcurrency = positiveInteger(optionValue(args, "--health-concurrency") ?? env.CLAXEDO_STRESS_HEALTH_CONCURRENCY, 20)
  const fileRequests = positiveInteger(optionValue(args, "--file-requests") ?? env.CLAXEDO_STRESS_FILE_REQUESTS, 60)
  const fileConcurrency = positiveInteger(optionValue(args, "--file-concurrency") ?? env.CLAXEDO_STRESS_FILE_CONCURRENCY, 8)
  const fileSizeBytes = positiveInteger(optionValue(args, "--file-size-bytes") ?? env.CLAXEDO_STRESS_FILE_SIZE_BYTES, 1024 * 1024)
  const timeoutMs = positiveInteger(optionValue(args, "--timeout-ms") ?? env.CLAXEDO_STRESS_TIMEOUT_MS, 20_000)
  const manifest = optionValue(args, "--manifest") ?? env.CLAXEDO_STAGING_STRESS_MANIFEST
  const centralUrl = requireEnv(env, "CLAXEDO_CENTRAL_URL")
  const workspaceId = `ws_stress_${Date.now().toString(36)}`
  const hostId = `host_stress_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
  const directToken = `direct_${crypto.randomUUID()}`
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-staging-stress-"))
  const session = await createSessionToken(env)
  const previousDirectory = process.env.WORKSPACE_RUNTIME_DIRECTORY
  const previousWorkspaceId = process.env.WORKSPACE_RUNTIME_WORKSPACE_ID
  const previousHostId = process.env.WORKSPACE_RUNTIME_HOST_ID
  process.env.WORKSPACE_RUNTIME_DIRECTORY = workspaceDir
  process.env.WORKSPACE_RUNTIME_WORKSPACE_ID = workspaceId
  process.env.WORKSPACE_RUNTIME_HOST_ID = hostId
  let runtimeServer: ReturnType<typeof startServer> | undefined
  let tunnel: ReturnType<typeof startWorkspaceRelayHostTunnel> | undefined
  try {
    const registered = await registerUserHosted({
      env,
      token: session.token,
      workspaceId,
      hostId,
      displayName: `staging stress ${workspaceId}`,
    })
    const relayUrl = registered.hostTunnel?.relayUrl ?? requireEnv(env, "CLAXEDO_WORKSPACE_RELAY_URL")
    const hostTunnelToken = registered.hostTunnel?.hostTunnelToken
    if (!hostTunnelToken) throw new Error("Register response did not include a Host Tunnel Token")

    runtimeServer = startServer(0, {
      target: { workspaceId, directory: workspaceDir },
      relayHostAuth: {
        key: await loadRelayHostVerificationKeyOrJwks({
          WORKSPACE_RUNTIME_RELAY_JWKS_URL: route(relayUrl, "/.well-known/jwks.json"),
        }),
        workspaceId,
        hostId,
        trustedDirectToken: directToken,
        trustedDirectTokenForRequest: ({ token }) => !!token,
      },
    })
    globalThis.Response = NativeResponse
    const runtimeBaseUrl = `http://127.0.0.1:${await waitForWorkspaceRuntimeServerPort(runtimeServer, 0)}`
    await waitForRuntime(runtimeBaseUrl)
    await fs.writeFile(path.join(workspaceDir, "stress.bin"), Uint8Array.from({ length: fileSizeBytes }, (_, index) => (index * 17) % 251))

    tunnel = startWorkspaceRelayHostTunnel({
      relayUrl,
      hostId,
      workspaceIds: [workspaceId],
      localBaseUrl: runtimeBaseUrl,
      headers: { authorization: `Bearer ${hostTunnelToken}` },
      pingIntervalMs: 1_000,
      onEvent: (event) => {
        if (event.type === "open" || event.type === "auth-failed" || event.type === "reconnecting" || event.type === "closed") {
          console.warn(`[staging-stress] host tunnel ${JSON.stringify(event)}`)
        }
      },
    })

    const manualConnection = await mintAndRecordRuntimeAccessToken({
      env,
      authToken: session.token,
      workspaceId,
      hostId,
    })
    const connection = {
      runtimeAccessToken: manualConnection.runtimeAccessToken,
      relayUrl,
      workspaceId,
      hostId,
      homeRegion: registered.workspace?.home_region,
    }
    const relayRoute = (path: string, init: RequestInit = {}) => ({
      url: route(connection.relayUrl!, `/workspaces/${encodeURIComponent(workspaceId)}${path}`),
      init: {
        ...init,
        headers: {
          authorization: `Bearer ${connection.runtimeAccessToken}`,
          ...Object.fromEntries(new Headers(init.headers).entries()),
        },
      },
    })
    const directRoute = (path: string, init: RequestInit = {}) => ({
      url: `${runtimeBaseUrl}${path}`,
      init: {
        ...init,
        headers: {
          authorization: `Bearer ${directToken}`,
          "x-workspace-id": workspaceId,
          "x-forwarded-by": "workspace-relay",
          ...Object.fromEntries(new Headers(init.headers).entries()),
        },
      },
    })

    await Promise.all([
      requestWithTimeout({ ...directRoute("/api/wr/health"), timeoutMs }),
      requestWithTimeout({ ...relayRoute("/api/wr/health"), timeoutMs }),
      requestWithTimeout({ ...directRoute("/file/raw?path=stress.bin"), timeoutMs }),
      requestWithTimeout({ ...relayRoute("/file/raw?path=stress.bin"), timeoutMs }),
    ])

    const batches = [
      await runBatch({
        name: "health",
        target: "direct",
        requests: healthRequests,
        concurrency: healthConcurrency,
        task: () => requestWithTimeout({ ...directRoute("/api/wr/health"), timeoutMs }),
      }),
      await runBatch({
        name: "health",
        target: "staging-relay",
        requests: healthRequests,
        concurrency: healthConcurrency,
        task: () => requestWithTimeout({ ...relayRoute("/api/wr/health"), timeoutMs }),
      }),
      await runBatch({
        name: "raw-file",
        target: "direct",
        requests: fileRequests,
        concurrency: fileConcurrency,
        task: () => requestWithTimeout({ ...directRoute("/file/raw?path=stress.bin"), timeoutMs }),
      }),
      await runBatch({
        name: "raw-file",
        target: "staging-relay",
        requests: fileRequests,
        concurrency: fileConcurrency,
        task: () => requestWithTimeout({ ...relayRoute("/file/raw?path=stress.bin"), timeoutMs }),
      }),
    ]
    for (const batch of batches) printBatch(batch)
    const result = {
      generatedAt: new Date().toISOString(),
      centralUrl,
      relayUrl: connection.relayUrl,
      workspaceId,
      hostId,
      homeRegion: connection.homeRegion,
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
    runtimeServer?.close()
    await fetch(route(centralUrl, `/api/workspace/${encodeURIComponent(workspaceId)}/user-hosted/pause`), {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ hostId, paused: true }),
    }).catch(() => undefined)
    await clerk(env, `/sessions/${encodeURIComponent(session.sessionId)}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).catch(() => undefined)
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
