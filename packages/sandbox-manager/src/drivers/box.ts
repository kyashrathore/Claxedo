import type {
  SandboxDriver,
  SandboxDriverEnsureInput,
  SandboxLease,
  SandboxTarget,
} from ".."
import { workspaceRuntimeSourceEnv, workspaceRuntimeTargetEnv } from "../runtime-env"
import { shell } from "../command"
import { DEFAULT_WORKSPACE_RUNTIME_PORT } from "../constants"
import { SANDBOX_IMAGE } from "../image"
import { sandboxDriverCatalog } from "../driver-catalog"

// Box by ASCII (https://box.ascii.dev) exposes persistent Linux microVMs over a
// small REST API. Unlike Daytona/Modal/Vercel, a Box boots a *fixed* base image
// with no workspace-runtime baked in — but it ships Docker-in-VM, so this driver
// delivers the canonical sandbox OCI image by `docker run`-ing it inside the box
// (the same image the Docker/Daytona/Modal drivers use) and then publishes the
// runtime port to a public HTTPS URL via Box's `host` command. The control plane
// reaches that URL over the relay, exactly like the other remote drivers.

export type BoxApiBox = {
  id: string
  name?: string
  state: string
  url?: string | null
  ip?: string | null
  subdomain?: string | null
  createdAt?: string | null
}

export type BoxCommandResult = {
  stdout?: string
  stderr?: string
  exitCode?: number
}

export type BoxFetch = (input: string, init?: RequestInit) => Promise<Response>

export type BoxSandboxDriverOptions = {
  apiKey: string
  baseUrl?: string
  image?: string
  runtimePort?: number
  runtimeCommand?: string
  workspaceDir?: string
  runner?: string
  /** Container name used for the runtime container inside the box. */
  containerName?: string
  /**
   * Box auto-archives after this many seconds of inactivity. `null` (default)
   * disables auto-archival so the SandboxManager owns the lifecycle; a number
   * lets Box reclaim idle boxes to save cost.
   */
  ttlSeconds?: number | null
  /**
   * Optional `docker login` before the pull, for a private runtime registry
   * (the default image lives on ghcr.io). Omit for public images.
   */
  registryAuth?: { server: string; username: string; password: string }
  env?: (input: SandboxDriverEnsureInput, host: { id: string }) => Record<string, string> | Promise<Record<string, string>>
  provisionTimeoutMs?: number
  provisionIntervalMs?: number
  healthTimeoutMs?: number
  healthIntervalMs?: number
  operationTimeoutMs?: number
  fetchImpl?: BoxFetch
}

const DEFAULT_BASE_URL = "https://ascii.dev/api/box/v1"
const DEFAULT_RUNTIME_COMMAND = "/usr/local/bin/workspace-runtime"
const DEFAULT_WORKSPACE_DIR = "/workspace"
const DEFAULT_CONTAINER_NAME = "claxedo-runtime"
const DEFAULT_PROVISION_TIMEOUT_MS = 120_000
const DEFAULT_PROVISION_INTERVAL_MS = 2_000
const DEFAULT_HEALTH_TIMEOUT_MS = 60_000
const DEFAULT_HEALTH_INTERVAL_MS = 1_000
const DEFAULT_OPERATION_TIMEOUT_MS = 120_000

// Box lifecycle states that accept commands / interactive access.
const READY_STATES = new Set(["ready", "idle", "running"])
// States that are still coming up — keep polling.
const PENDING_STATES = new Set(["init", "provisioning", "provisioned", "cloning"])

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clean(input: string | undefined | null) {
  const txt = input?.trim()
  return txt ? txt : undefined
}

function transientDriverError(err: unknown) {
  const shaped = err as { status?: number; code?: string; name?: string; message?: string }
  if (typeof shaped.status === "number" && shaped.status >= 500) return true
  const text = `${shaped.code ?? ""} ${shaped.name ?? ""} ${shaped.message ?? ""}`.toLowerCase()
  return text.includes("timeout") || text.includes("unavailable") || text.includes("econnreset") || text.includes("network")
}

class BoxApiError extends Error {
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = "BoxApiError"
    this.status = status
  }
}

export function createBoxSandboxDriver(options: BoxSandboxDriverOptions): SandboxDriver {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
  const image = options.image ?? SANDBOX_IMAGE
  const runtimeCommand = options.runtimeCommand ?? DEFAULT_RUNTIME_COMMAND
  const workspaceDir = options.workspaceDir ?? DEFAULT_WORKSPACE_DIR
  const containerName = options.containerName ?? DEFAULT_CONTAINER_NAME
  const ttlSeconds = options.ttlSeconds === undefined ? null : options.ttlSeconds
  const provisionTimeoutMs = options.provisionTimeoutMs ?? DEFAULT_PROVISION_TIMEOUT_MS
  const provisionIntervalMs = options.provisionIntervalMs ?? DEFAULT_PROVISION_INTERVAL_MS
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS
  const healthIntervalMs = options.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS
  const operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS
  const fetchImpl = options.fetchImpl ?? fetch

  async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    let res: Response
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method: init?.method ?? "GET",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(operationTimeoutMs),
      })
    } catch (err) {
      throw new BoxApiError(err instanceof Error ? err.message : String(err))
    }
    const text = await res.text()
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {}
    if (!res.ok || body.ok === false) {
      const detail = clean(body.error as string) ?? clean(body.message as string) ?? res.statusText
      throw new BoxApiError(`Box API ${init?.method ?? "GET"} ${path} failed: ${detail}`, res.status)
    }
    return body as T
  }

  function runtimePort(input: SandboxDriverEnsureInput) {
    return input.workspaceRuntimePort ?? options.runtimePort ?? DEFAULT_WORKSPACE_RUNTIME_PORT
  }

  function workspaceDirectory(input: SandboxDriverEnsureInput) {
    return input.workspaceRoot ?? workspaceDir
  }

  function resolveImage(input: SandboxDriverEnsureInput) {
    if (input.bootSource?.kind === "image") return input.bootSource.image
    return input.snapshot ?? image
  }

  function bootEnv(input: SandboxDriverEnsureInput, hostId: string): Record<string, string> {
    const env: Record<string, string> = {
      ...workspaceRuntimeTargetEnv({
        workspaceId: input.workspaceId,
        hostId,
        directory: workspaceDirectory(input),
        port: runtimePort(input),
        host: "0.0.0.0",
      }),
      ...workspaceRuntimeSourceEnv({ source: input.source }),
      ...input.env,
    }
    if (options.runner) env.WORKSPACE_RUNTIME_RUNNER = options.runner
    return env
  }

  async function exec(boxId: string, command: string): Promise<BoxCommandResult> {
    const body = await api<Record<string, unknown>>(`/boxes/${boxId}/commands`, {
      method: "POST",
      body: { command },
    })
    const result = (body.result as BoxCommandResult | undefined) ?? (body as BoxCommandResult)
    return {
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
      exitCode: typeof result.exitCode === "number" ? result.exitCode : 0,
    }
  }

  async function execOrThrow(boxId: string, command: string, label: string): Promise<BoxCommandResult> {
    const result = await exec(boxId, command)
    if ((result.exitCode ?? 0) !== 0) {
      throw new BoxApiError(`Box ${boxId} ${label} failed (exit ${result.exitCode}): ${clean(result.stderr) ?? clean(result.stdout) ?? ""}`)
    }
    return result
  }

  async function waitUntilReady(boxId: string): Promise<boolean> {
    const until = Date.now() + provisionTimeoutMs
    for (;;) {
      const { box } = await api<{ box: BoxApiBox }>(`/boxes/${boxId}`)
      if (READY_STATES.has(box.state)) return true
      if (!PENDING_STATES.has(box.state)) {
        throw new BoxApiError(`Box ${boxId} entered non-ready state: ${box.state}`)
      }
      if (Date.now() >= until) return false
      await sleep(provisionIntervalMs)
    }
  }

  function dockerRunScript(input: SandboxDriverEnsureInput, env: Record<string, string>): string {
    const port = runtimePort(input)
    const directory = workspaceDirectory(input)
    const bootScript = [`mkdir -p ${shell(directory)}`, `cd ${shell(directory)}`, `exec ${runtimeCommand}`].join(" && ")
    const envArgs = Object.entries(env)
      .map(([key, value]) => `--env ${shell(`${key}=${value}`)}`)
      .join(" ")
    const login = options.registryAuth
      ? `echo ${shell(options.registryAuth.password)} | docker login ${shell(options.registryAuth.server)} --username ${shell(options.registryAuth.username)} --password-stdin && `
      : ""
    return (
      `${login}docker rm -f ${containerName} >/dev/null 2>&1 || true; ` +
      `docker run -d --name ${containerName} -p ${port}:${port} ${envArgs} ` +
      `--entrypoint sh ${shell(resolveImage(input))} -lc ${shell(bootScript)}`
    )
  }

  async function waitForHealth(boxId: string, input: SandboxDriverEnsureInput) {
    const port = runtimePort(input)
    const until = Date.now() + healthTimeoutMs
    let last = "workspace runtime not ready"
    while (Date.now() < until) {
      const probe = await exec(
        boxId,
        `curl -sf -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/global/health || true`,
      )
      const code = clean(probe.stdout)
      if (code === "200") return
      last = `health probe returned ${code ?? "no response"}`
      await sleep(healthIntervalMs)
    }
    throw new BoxApiError(`Box ${boxId} runtime did not become healthy: ${last}`)
  }

  async function boot(boxId: string, input: SandboxDriverEnsureInput, hostId: string): Promise<SandboxTarget> {
    const env = {
      ...bootEnv(input, hostId),
      ...(await options.env?.(input, { id: hostId })),
    }
    const port = runtimePort(input)
    await execOrThrow(boxId, dockerRunScript(input, env), "docker run")
    // Publish the box-host port to a stable public HTTPS route, then read it back.
    await execOrThrow(boxId, `host ${port}`, "host publish")
    await waitForHealth(boxId, input)
    const urlResult = await execOrThrow(boxId, `host url ${port}`, "host url")
    const url = clean(urlResult.stdout?.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop())
    if (!url) throw new BoxApiError(`Box ${boxId} did not return a public URL for port ${port}`)
    return {
      workspaceId: input.workspaceId,
      sandboxId: boxId,
      url,
      hostId,
      driverResourceId: boxId,
      driver: { id: "box", resourceId: boxId },
      labels: input.labels,
    }
  }

  function assertNetwork(input: SandboxDriverEnsureInput) {
    if (input.net && input.net.mode !== "allow-all") {
      throw new BoxApiError("Box SandboxDriver cannot enforce host-based network policy")
    }
  }

  async function ensureHost(input: SandboxDriverEnsureInput) {
    assertNetwork(input)
    const hostId = input.hostId ?? `box-${input.workspaceId}`
    const created = await api<{ box: BoxApiBox }>("/boxes", {
      method: "POST",
      body: { ttlSeconds },
    }).catch((err) => {
      if (transientDriverError(err)) return undefined
      throw err
    })
    if (!created) return { provisioning: true as const, retryAfterMs: provisionIntervalMs }
    const boxId = created.box.id
    const ready = await waitUntilReady(boxId)
    if (!ready) return { provisioning: true as const, retryAfterMs: provisionIntervalMs }
    return boot(boxId, input, hostId)
  }

  async function resumeHost(input: { lease: SandboxLease; ensure: SandboxDriverEnsureInput }) {
    const boxId = input.lease.sandboxId
    if (!boxId) return ensureHost(input.ensure)
    assertNetwork(input.ensure)
    const hostId = input.ensure.hostId ?? input.lease.hostId ?? `box-${input.ensure.workspaceId}`
    try {
      await api(`/boxes/${boxId}/resume`, { method: "POST" })
      const ready = await waitUntilReady(boxId)
      if (!ready) return { provisioning: true as const, retryAfterMs: provisionIntervalMs }
      // Re-establish the runtime container + route: an archived box stops its
      // processes, so the container and `host` route must be brought back.
      return await boot(boxId, input.ensure, hostId)
    } catch (err) {
      if (transientDriverError(err)) return { provisioning: true as const, retryAfterMs: provisionIntervalMs }
      // A resume against a deleted/errored box falls back to a fresh box.
      return ensureHost(input.ensure)
    }
  }

  async function stop(target: SandboxTarget) {
    await api(`/boxes/${target.sandboxId}/stop`, { method: "POST" })
  }

  async function destroy(target: SandboxTarget) {
    await api(`/boxes/${target.sandboxId}`, { method: "DELETE" })
  }

  return {
    id: "box",
    metadata: {
      driverRunsIn: ["node"],
      hostStopBehavior: "suspends-host",
      hostResumeBehavior: "same-host",
      targetAccess: "relay",
      secretBrokering: "none",
      egressControl: "none",
      persistence: sandboxDriverCatalog.box.metadata.persistence,
    },
    ensureHost,
    resumeHost,
    async touch() {},
    suspend: stop,
    stop,
    destroy,
  }
}
