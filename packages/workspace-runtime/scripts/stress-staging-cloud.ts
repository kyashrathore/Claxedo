import fs from "node:fs/promises"
import path from "node:path"

type Env = Record<string, string | undefined>
type Connection = {
  status?: string
  runtimeAccessToken?: string
  relayUrl?: string
  workspaceId?: string
  hostId?: string
  homeRegion?: string
  error?: { retryAfterMs?: number; code?: string; message?: string }
}
type BatchResult = {
  name: string
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
  serverTiming?: Record<string, {
    count: number
    p50Ms?: number
    p95Ms?: number
    p99Ms?: number
    maxMs?: number
  }>
  responseHeaders?: {
    cfColos?: Record<string, number>
    relayLocationHints?: Record<string, number>
    servers?: Record<string, number>
    cfRaySamples?: string[]
  }
  slowTraces?: Array<{ traceId?: string; cfRay?: string; cfColo?: string; ms: number }>
  errors: string[]
}
type RequestTiming = {
  ms: number
  bytes: number
  serverTiming: Record<string, number>
  traceId?: string
  cfRay?: string
  cfColo?: string
  relayLocationHint?: string
  server?: string
}
type LaunchResult =
  | { kind: "started"; process?: unknown }
  | { kind: "already_running"; process?: unknown }
  | { kind: "failed"; error?: string }
  | { kind: "not_found"; error?: string }
  | { kind: "port_conflict"; conflict?: unknown }
  | { kind: "route_conflict"; conflict?: unknown }

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

function nonNegativeInteger(value: string | undefined, fallback: number) {
  const parsed = Number(clean(value))
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}

async function loadEnv(...files: string[]) {
  const parsed: Env = {}
  for (const file of files) {
    const text = await fs.readFile(file, "utf8").catch(() => "")
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
      if (!match) continue
      parsed[match[1]] = match[2]?.trim().replace(/^['"]|['"]$/g, "")
    }
  }
  return { ...parsed, ...process.env }
}

function requireEnv(env: Env, key: string) {
  const value = clean(env[key])
  if (!value) throw new Error(`${key} is required`)
  return value
}

function route(base: string, pathname: string) {
  return new URL(pathname.replace(/^\/+/, ""), base.endsWith("/") ? base : `${base}/`).toString()
}

async function clerk(env: Env, pathname: string, init: RequestInit = {}) {
  return await fetch(`https://api.clerk.com/v1${pathname}`, {
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
    body: JSON.stringify({ expires_in_seconds: 1_800 }),
  })).json() as { jwt?: string }
  if (!token.jwt) throw new Error("Clerk session token creation did not return a JWT")
  return { sessionId: session.id, token: token.jwt }
}

async function expectJson<T>(res: Response, label: string) {
  const text = await res.text()
  if (res.ok) return JSON.parse(text) as T
  throw new Error(`${label} returned ${res.status}: ${text.slice(0, 500)}`)
}

function assertLaunchOk(result: LaunchResult, label: string) {
  if (result.kind === "started" || result.kind === "already_running") return
  throw new Error(`${label} failed: ${JSON.stringify(result).slice(0, 500)}`)
}

async function createWorkspace(input: { centralUrl: string; token: string }) {
  const body = await expectJson<{ workspaceId?: string; directory?: string }>(
    await fetch(route(input.centralUrl, "/api/workspace/create"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspaceName: `daytona stress ${Date.now()}`,
        projectName: "daytona-stress",
      }),
    }),
    "cloud workspace create",
  )
  if (!body.workspaceId) throw new Error("Cloud workspace create did not return workspaceId")
  return body.workspaceId
}

async function waitForConnection(input: { centralUrl: string; token: string; workspaceId: string }) {
  let last = "no response"
  for (let i = 0; i < 180; i++) {
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
        return JSON.parse(text) as Connection
      } catch {
        return undefined
      }
    })()
    if (res.ok && body?.runtimeAccessToken && body.relayUrl) return body
    const retryAfter = body?.error?.retryAfterMs
    await new Promise((resolve) => setTimeout(resolve, retryAfter ? Math.min(Math.max(retryAfter, 1_000), 20_000) : 2_500))
  }
  throw new Error(`Cloud workspace connection did not become ready; last=${last}`)
}

async function requestWithTimeout(input: { url: string; init?: RequestInit; timeoutMs: number }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs)
  const startedAt = performance.now()
  try {
    const res = await fetch(input.url, { ...input.init, signal: controller.signal })
    const serverTiming = parseServerTiming(res.headers.get("server-timing"))
    const traceId = clean(res.headers.get("x-claxedo-trace-id") ?? undefined)
    const cfRay = clean(res.headers.get("cf-ray") ?? undefined)
    const relayLocationHint = clean(res.headers.get("x-claxedo-relay-location-hint") ?? undefined)
    const server = clean(res.headers.get("server") ?? undefined)
    const body = await res.arrayBuffer()
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${new TextDecoder().decode(body).slice(0, 200)}`)
    return {
      ms: performance.now() - startedAt,
      bytes: body.byteLength,
      serverTiming,
      ...(traceId ? { traceId } : {}),
      ...(cfRay ? { cfRay, cfColo: cfRayColo(cfRay) } : {}),
      ...(relayLocationHint ? { relayLocationHint } : {}),
      ...(server ? { server } : {}),
    }
  } finally {
    clearTimeout(timer)
  }
}

function cfRayColo(input: string) {
  return clean(input.split("-").at(-1))
}

function parseServerTiming(input: string | null) {
  const result: Record<string, number> = {}
  for (const entry of (input ?? "").split(",")) {
    const name = clean(entry.split(";")[0])
    if (!name) continue
    const dur = /(?:^|;)dur=([0-9.]+)/.exec(entry)?.[1]
    const parsed = Number(dur)
    if (Number.isFinite(parsed)) result[name] = parsed
  }
  return result
}

function percentile(sorted: number[], p: number) {
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(Math.max(rank - 1, 0), sorted.length - 1)]
}

function round(value: number) {
  return Math.round(value * 100) / 100
}

function counts(values: Array<string | undefined>) {
  const result: Record<string, number> = {}
  for (const value of values) {
    if (!value) continue
    result[value] = (result[value] ?? 0) + 1
  }
  return result
}

async function runBatch(input: {
  name: string
  requests: number
  concurrency: number
  task: () => Promise<RequestTiming>
}) {
  const samples: RequestTiming[] = []
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
        samples.push(result)
        bytes += result.bytes
      } catch (err) {
        if (errors.length < 10) errors.push(err instanceof Error ? err.message : String(err))
      }
    }
  }))
  const totalMs = performance.now() - startedAt
  const sorted = samples.map((sample) => sample.ms).sort((a, b) => a - b)
  const serverTiming = serverTimingStats(samples)
  const responseHeaders = responseHeaderStats(samples)
  const slowTraces = samples
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 10)
    .map((sample) => ({
      ...(sample.traceId ? { traceId: sample.traceId } : {}),
      ...(sample.cfRay ? { cfRay: sample.cfRay } : {}),
      ...(sample.cfColo ? { cfColo: sample.cfColo } : {}),
      ms: round(sample.ms),
    }))
  const seconds = Math.max(totalMs / 1000, 0.001)
  return {
    name: input.name,
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
    ...(Object.keys(serverTiming).length ? { serverTiming } : {}),
    ...(responseHeaders ? { responseHeaders } : {}),
    ...(slowTraces.length ? { slowTraces } : {}),
    errors,
  } satisfies BatchResult
}

function serverTimingStats(samples: RequestTiming[]) {
  const byName = new Map<string, number[]>()
  for (const sample of samples) {
    for (const [name, ms] of Object.entries(sample.serverTiming)) {
      byName.set(name, [...(byName.get(name) ?? []), ms])
    }
  }
  return Object.fromEntries([...byName.entries()].map(([name, values]) => {
    const sorted = values.sort((a, b) => a - b)
    return [name, {
      count: sorted.length,
      p50Ms: round(percentile(sorted, 50)),
      p95Ms: round(percentile(sorted, 95)),
      p99Ms: round(percentile(sorted, 99)),
      maxMs: round(sorted[sorted.length - 1]),
    }]
  }))
}

function responseHeaderStats(samples: RequestTiming[]) {
  const cfColos = counts(samples.map((sample) => sample.cfColo))
  const relayLocationHints = counts(samples.map((sample) => sample.relayLocationHint))
  const servers = counts(samples.map((sample) => sample.server))
  const cfRaySamples = samples
    .map((sample) => sample.cfRay)
    .filter((value): value is string => !!value)
    .slice(0, 10)
  if (!Object.keys(cfColos).length && !Object.keys(relayLocationHints).length && !Object.keys(servers).length && !cfRaySamples.length) return undefined
  return {
    ...(Object.keys(cfColos).length ? { cfColos } : {}),
    ...(Object.keys(relayLocationHints).length ? { relayLocationHints } : {}),
    ...(Object.keys(servers).length ? { servers } : {}),
    ...(cfRaySamples.length ? { cfRaySamples } : {}),
  }
}

function printBatch(item: BatchResult) {
  const stats = item.ok
    ? `min=${item.minMs} p50=${item.p50Ms} p90=${item.p90Ms} p95=${item.p95Ms} p99=${item.p99Ms} max=${item.maxMs}`
    : "no successful samples"
  console.log([
    item.failed ? "FAIL" : "PASS",
    item.name,
    `ok=${item.ok}/${item.requests}`,
    `c=${item.concurrency}`,
    `total=${item.totalMs}ms`,
    `rps=${item.rps}`,
    `mbps=${item.mbps}`,
    stats,
  ].join(" "))
  for (const error of item.errors) console.log(`  error: ${error}`)
  if (item.serverTiming) {
    for (const [name, timing] of Object.entries(item.serverTiming)) {
      console.log(`  timing ${name}: count=${timing.count} p50=${timing.p50Ms} p95=${timing.p95Ms} p99=${timing.p99Ms} max=${timing.maxMs}`)
    }
  }
  if (item.responseHeaders?.cfColos) console.log(`  cf colos: ${JSON.stringify(item.responseHeaders.cfColos)}`)
  if (item.responseHeaders?.relayLocationHints) console.log(`  relay location hints: ${JSON.stringify(item.responseHeaders.relayLocationHints)}`)
  if (item.responseHeaders?.servers) console.log(`  servers: ${JSON.stringify(item.responseHeaders.servers)}`)
  for (const trace of item.slowTraces ?? []) {
    console.log(`  slow trace: ${trace.traceId ?? "no-trace"} ${trace.cfRay ?? "no-cf-ray"} ${trace.cfColo ?? "no-colo"} ${trace.ms}ms`)
  }
}

async function main() {
  const args = process.argv.slice(2)
  const env = await loadEnv(
    optionValue(args, "--server-env-file") ?? "../claxedo-server/.env",
    optionValue(args, "--env-file") ?? "../claxedo-server/.env.local",
  )
  const healthRequests = positiveInteger(optionValue(args, "--health-requests") ?? env.CLAXEDO_STRESS_HEALTH_REQUESTS, 120)
  const healthConcurrency = positiveInteger(optionValue(args, "--health-concurrency") ?? env.CLAXEDO_STRESS_HEALTH_CONCURRENCY, 20)
  const fileRequests = nonNegativeInteger(optionValue(args, "--file-requests") ?? env.CLAXEDO_STRESS_FILE_REQUESTS, 40)
  const fileConcurrency = positiveInteger(optionValue(args, "--file-concurrency") ?? env.CLAXEDO_STRESS_FILE_CONCURRENCY, 8)
  const fileSizeBytes = positiveInteger(optionValue(args, "--file-size-bytes") ?? env.CLAXEDO_STRESS_FILE_SIZE_BYTES, 1024 * 1024)
  const timeoutMs = positiveInteger(optionValue(args, "--timeout-ms") ?? env.CLAXEDO_STRESS_TIMEOUT_MS, 30_000)
  const seedProbeTimeoutMs = Math.min(timeoutMs, positiveInteger(optionValue(args, "--seed-timeout-ms") ?? env.CLAXEDO_STRESS_SEED_TIMEOUT_MS, 3_000))
  const manifest = optionValue(args, "--manifest") ?? env.CLAXEDO_STAGING_CLOUD_STRESS_MANIFEST
  const traceRequests = args.includes("--trace") || clean(env.CLAXEDO_STRESS_TRACE) === "1"
  const includeDirect = args.includes("--direct") || clean(env.CLAXEDO_STRESS_DIRECT) === "1"
  const directSandboxBaseUrl = optionValue(args, "--direct-sandbox-base-url") ?? env.CLAXEDO_STRESS_DIRECT_SANDBOX_BASE_URL
  const directHealthPath = optionValue(args, "--direct-health-path") ?? env.CLAXEDO_STRESS_DIRECT_HEALTH_PATH ?? "/health"
  const centralUrl = requireEnv(env, "CLAXEDO_CENTRAL_URL")
  const existingWorkspaceId = optionValue(args, "--workspace-id") ?? env.CLAXEDO_STRESS_WORKSPACE_ID
  const session = await createSessionToken(env)
  let workspaceId: string | undefined
  try {
    workspaceId = existingWorkspaceId ?? await createWorkspace({ centralUrl, token: session.token })
    console.log(`${existingWorkspaceId ? "Using" : "Created"} cloud workspace ${workspaceId}`)
    const connection = await waitForConnection({ centralUrl, token: session.token, workspaceId })
    console.log(`Connection ready workspace=${workspaceId} host=${connection.hostId ?? ""} relay=${connection.relayUrl ?? ""}`)
    const relayUrl = connection.relayUrl!
    const directUrl = directSandboxBaseUrl
      ?? (includeDirect && connection.hostId ? `https://sandbox.claxedo.com/sandbox/${encodeURIComponent(connection.hostId)}/proxy/global` : undefined)
    const relayRoute = (pathname: string, init: RequestInit = {}) => ({
      url: route(relayUrl, `/workspaces/${encodeURIComponent(workspaceId!)}${pathname}`),
      init: {
        ...init,
        headers: {
          authorization: `Bearer ${connection.runtimeAccessToken}`,
          ...(traceRequests ? { "x-claxedo-relay-trace": "1" } : {}),
          ...Object.fromEntries(new Headers(init.headers).entries()),
        },
      },
    })
    const directRoute = directUrl
      ? (pathname: string, init: RequestInit = {}) => ({
          url: route(directUrl, pathname),
          init: {
            ...init,
            headers: {
              ...(traceRequests ? { "x-claxedo-relay-trace": "1" } : {}),
              ...Object.fromEntries(new Headers(init.headers).entries()),
            },
          },
        })
      : undefined
    const relayFetch = async <T>(pathname: string, init: RequestInit, label: string) => {
      const request = relayRoute(pathname, init)
      return await expectJson<T>(await fetch(request.url, request.init), label)
    }

    await requestWithTimeout({ ...relayRoute("/api/wr/health"), timeoutMs })
    if (directRoute) await requestWithTimeout({ ...directRoute(directHealthPath), timeoutMs })

    if (fileRequests > 0) {
      const processId = `proc_stress_${Date.now().toString(36)}`
      console.log(`Seeding ${fileSizeBytes} bytes through managed process ${processId}`)
      await relayFetch<unknown>(
        "/api/claxedo/process",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: processId,
            name: "staging-stress-seed",
            command: `sh -lc 'head -c ${fileSizeBytes} /dev/zero > stress.bin; sleep 5'`,
          }),
        },
        "process config create",
      )
      assertLaunchOk(await relayFetch<LaunchResult>(
        `/api/claxedo/process/${encodeURIComponent(processId)}/start`,
        { method: "POST" },
        "process start",
      ), "process start")
      for (let i = 0; i < 80; i++) {
        const probe = await requestWithTimeout({ ...relayRoute("/file/raw?path=stress.bin"), timeoutMs: seedProbeTimeoutMs }).catch(() => undefined)
        if (probe?.bytes === fileSizeBytes) break
        if (i === 79) {
          const diagnostics = await relayFetch<unknown>("/api/claxedo/process/diagnostics", {}, "process diagnostics")
            .catch((err) => err instanceof Error ? err.message : String(err))
          throw new Error(`stress.bin was not created in the cloud runtime; diagnostics=${JSON.stringify(diagnostics).slice(0, 1000)}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }

    const batches = [
      ...(directRoute ? [await runBatch({
        name: "health.direct-sandbox-daytona",
        requests: healthRequests,
        concurrency: healthConcurrency,
        task: () => requestWithTimeout({ ...directRoute(directHealthPath), timeoutMs }),
      })] : []),
      await runBatch({
        name: "health.staging-relay-daytona",
        requests: healthRequests,
        concurrency: healthConcurrency,
        task: () => requestWithTimeout({ ...relayRoute("/api/wr/health"), timeoutMs }),
      }),
      ...(fileRequests > 0 ? [
        await runBatch({
          name: "raw-file.staging-relay-daytona",
          requests: fileRequests,
          concurrency: fileConcurrency,
          task: () => requestWithTimeout({ ...relayRoute("/file/raw?path=stress.bin"), timeoutMs }),
        }),
      ] : []),
    ]
    for (const batch of batches) printBatch(batch)
    const result = {
      generatedAt: new Date().toISOString(),
      centralUrl,
      relayUrl,
      directUrl,
      workspaceId,
      hostId: connection.hostId,
      homeRegion: connection.homeRegion,
      config: {
        healthRequests,
        healthConcurrency,
        fileRequests,
        fileConcurrency,
        fileSizeBytes,
        timeoutMs,
        traceRequests,
        includeDirect: !!directRoute,
        directHealthPath,
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
    await clerk(env, `/sessions/${encodeURIComponent(session.sessionId)}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).catch(() => undefined)
    if (workspaceId) console.log(`Created cloud workspace ${workspaceId}`)
  }
}

await main()
