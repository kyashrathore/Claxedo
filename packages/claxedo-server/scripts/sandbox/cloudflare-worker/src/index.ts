import { apiTokenMatches } from "./api-token"
import { placeholderAdded, readRegistrations } from "./egress-store"
import { credentialPlaceholder, parseRegistrations, type EgressRegistration } from "./outbound-credentials"
import { listSandboxes, registerSandbox, unregisterSandbox } from "./sandbox-registry"
import type { WorkerEnv } from "./worker-env"
import { asWorkerRecord, stringMap } from "./worker-json"
import { workspaceIdlePlacement } from "./workspace-idle"
import type { WorkspaceEnsure } from "./workspace-sandbox"
import { workerRuntimeBuild } from "./runtime-integrity"
import { CHECKPOINT_UNUSABLE } from "./workspace-snapshot"

export { CredentialEgress } from "./credential-egress"
export { WorkspaceSandbox } from "./workspace-sandbox"

/**
 * A Durable Object is placed near whoever first reaches it and never moves,
 * and its container is placed near it. Unhinted, a workspace opened from
 * India lands in HKG, where Anthropic and OpenAI refuse every request, so
 * every sandbox lives in ENAM beside the control plane.
 */
const SANDBOX_PLACEMENT = { locationHint: "enam" } as const

/** Keep aligned with @claxedo/sandbox-manager's DEFAULT_WORKSPACE_RUNTIME_PORT: the driver's ensure names it and the proxy forwards to it. */
const WORKSPACE_RUNTIME_PORT = 2593
const TRACE_ID_HEADER = "x-claxedo-trace-id"

function roundedMs(value: number) {
  return Math.round(value * 100) / 100
}

function withServerTiming(response: Response, name: string, startedAt: number, traceId: string | null) {
  if (response.status === 101 || (response as Response & { webSocket?: unknown }).webSocket) return response
  const headers = new Headers(response.headers)
  const value = `${name};dur=${roundedMs(performance.now() - startedAt)}`
  headers.set("server-timing", headers.get("server-timing") ? `${headers.get("server-timing")}, ${value}` : value)
  if (traceId) headers.set(TRACE_ID_HEADER, traceId)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status })
}

async function auth(request: Request, env: WorkerEnv): Promise<Response | null> {
  const header = request.headers.get("Authorization")
  if (!header?.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401)
  if (!env.API_TOKEN || !await apiTokenMatches(header.slice(7), env.API_TOKEN)) return json({ error: "forbidden" }, 403)
  return null
}

function sandboxStub(env: WorkerEnv, sandboxId: string) {
  return env.WORKSPACE_SANDBOX.getByName(sandboxId, SANDBOX_PLACEMENT)
}

function restoreSnapshot(input: unknown): string | undefined | null {
  if (input === undefined) return undefined
  const snapshotId = asWorkerRecord(input)?.snapshotId
  return typeof snapshotId === "string" && snapshotId ? snapshotId : null
}

/**
 * Relay traffic reaches the runtime port through the sandbox's own object, so
 * no preview hostname or wildcard certificate is needed. It is not behind
 * API_TOKEN: the runtime verifies the Relay Host Token the relay sends on the
 * same `Authorization` header, which is forwarded untouched.
 */
async function proxy(request: Request, env: WorkerEnv, parts: string[]) {
  const startedAt = performance.now()
  const target = new URL(request.url)
  // A container's TCP port answers HTTP only; an https URL is refused with a 1101.
  target.protocol = "http:"
  target.pathname = "/" + parts.slice(3).join("/")
  const response = await sandboxStub(env, parts[1]).fetch(new Request(target.toString(), request))
  return withServerTiming(response, "sandbox-container", startedAt, request.headers.get(TRACE_ID_HEADER))
}

async function ensureRuntime(request: Request, env: WorkerEnv, sandboxId: string, body: Record<string, unknown>) {
  const sandbox = sandboxStub(env, sandboxId)
  const containerEnv = stringMap(body.env)
  const port = typeof body.port === "number" ? body.port : WORKSPACE_RUNTIME_PORT
  const command = typeof body.command === "string" ? body.command : ""
  if (!command) return json({ error: "ensure-runtime requires `command`" }, 400)
  const restore = restoreSnapshot(body.restore)
  if (restore === null) return json({ error: "ensure-runtime restore requires the checkpoint's snapshot id" }, 400)
  const minimumRuntimeVersion = typeof body.minimumRuntimeVersion === "string" && body.minimumRuntimeVersion ? body.minimumRuntimeVersion : undefined
  if (!workerRuntimeBuild(env)) return json({ error: "the sandbox Worker was deployed without RUNTIME_BUILD_ID, RUNTIME_VERSION and RUNTIME_DIGEST" }, 503)
  const labels = stringMap(body.labels)
  const idle = workspaceIdlePlacement(labels, port, env)
  if (!idle) return json({ error: "ensure-runtime requires workspaceId and epoch labels, and CONTROL_PLANE_URL for the idle lifecycle" }, 503)
  containerEnv.WORKSPACE_RUNTIME_CONFIG_TOKEN = await sandbox.configureWorkspaceIdle(idle)

  let previous: EgressRegistration[]
  try {
    previous = await readRegistrations(env.EGRESS_SECRETS, sandboxId)
  } catch {
    // Never read as "none": an unreadable store would silently clear a live sandbox's brokering.
    return json({ error: "egress registrations unreadable (EGRESS_SECRETS)" }, 503)
  }
  let registrations = previous
  if (body.egress !== undefined) {
    try {
      registrations = parseRegistrations(body.egress)
    } catch {
      return json({ error: "invalid egress registrations" }, 400)
    }
    if (registrations.length && !env.EGRESS_SECRETS) return json({ error: "egress broker requires EGRESS_SECRETS" }, 503)
    await env.EGRESS_SECRETS?.put(sandboxId, JSON.stringify(registrations))
  }
  // Only an added placeholder NAME needs a new process: a rotated value keeps
  // its placeholder, and a dropped one stays in the running process's
  // environment as a string this Worker no longer swaps.
  const placeholdersAdded = placeholderAdded(previous, registrations)
  await sandbox.setCredentialHosts(sandboxId, registrations.flatMap((row) => row.hosts))
  for (const row of registrations) containerEnv[row.name] = credentialPlaceholder(row.name)

  const runtime: WorkspaceEnsure = await sandbox.ensureWorkspace({
    command,
    env: containerEnv,
    port,
    reuseRunning: !placeholdersAdded,
    ...(restore ? { restore } : {}),
    ...(minimumRuntimeVersion ? { minimumRuntimeVersion } : {}),
  })
  if (runtime.state === "checkpoint-unusable") return json({ ready: false, checkpointUnusable: runtime.cause, error: CHECKPOINT_UNUSABLE[runtime.cause] }, 410)
  if (runtime.state === "exited") return json({ ready: false, exited: true, error: runtime.reason }, 502)
  if (runtime.state === "preparing") return json({ ready: false, error: "workspace-runtime did not become ready" }, 503)
  await registerSandbox(env.SANDBOX_REGISTRY, sandboxId, labels)
  await sandbox.watchWorkspaceIdle()
  return json({ ready: true, url: `${new URL(request.url).origin}/sandbox/${encodeURIComponent(sandboxId)}/proxy`, port })
}

async function control(request: Request, env: WorkerEnv, sandboxId: string, action: string) {
  const sandbox = sandboxStub(env, sandboxId)
  if (request.method === "DELETE" && !action) {
    await sandbox.destroyWorkspace()
    await env.EGRESS_SECRETS?.delete(sandboxId).catch(() => undefined)
    // Only after the sandbox is gone: a record dropped first would hide a failed destroy from the next sweep.
    await unregisterSandbox(env.SANDBOX_REGISTRY, sandboxId)
    return json({ ok: true })
  }
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405)
  const body = asWorkerRecord(await request.json().catch(() => undefined)) ?? {}
  switch (action) {
    case "ensure-runtime":
      return await ensureRuntime(request, env, sandboxId, body)
    case "touch-runtime": {
      const port = typeof body.port === "number" ? body.port : WORKSPACE_RUNTIME_PORT
      return json({ ok: true, ready: await sandbox.workspaceRuntimeReady(port) })
    }
    case "inspect":
      return json({ running: await sandbox.workspaceRunning() })
    case "stop": {
      if (typeof body.epoch !== "number" || !Number.isSafeInteger(body.epoch)) return json({ error: "stop requires the lease epoch" }, 400)
      return await sandbox.stopWorkspace(body.epoch) ? json({ ok: true }) : json({ ok: false, error: "a newer lease generation runs this sandbox" }, 409)
    }
    case "snapshot":
      return json(await sandbox.snapshotWorkspace())
    default:
      return json({ error: `unknown action: ${action}` }, 404)
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const parts = new URL(request.url).pathname.split("/").filter(Boolean)
    if (parts[0] === "sandbox" && parts[1] && parts[2] === "proxy") return await proxy(request, env, parts)

    const denied = await auth(request, env)
    if (denied) return denied

    // "No bucket" must never read as "no sandboxes", or a sweep reports a clean pass while seeing nothing.
    if (parts[0] === "sandboxes" && !parts[1]) {
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405)
      if (!env.SANDBOX_REGISTRY) return json({ supported: false, error: "sandbox registry not configured (bind SANDBOX_REGISTRY)" }, 501)
      return json({ supported: true, sandboxes: await listSandboxes(env.SANDBOX_REGISTRY) })
    }

    if (parts[0] !== "sandbox" || !parts[1]) return json({ error: "not found", usage: "/sandbox/:id/:action" }, 404)
    try {
      return await control(request, env, parts[1], parts[2] || "")
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return json({ error: error.message, name: error.name }, 500)
    }
  },
}
