import { trimToUndefined } from "@claxedo/helpers/string"
import type {
  SandboxDriver,
  SandboxDriverEnsureInput,
  SandboxLease,
  SandboxTarget,
  SandboxResource,
} from "../contract"
import { workspaceRuntimeBootEnv, type WorkspaceRuntimeControlEnv } from "../runtime-env"
import { envFile, shell } from "../command"
import { DEFAULT_WORKSPACE_RUNTIME_PORT } from "../constants"
import { assertSandboxImageReference } from "../image-name"
import { sandboxDriverCatalog } from "../driver-catalog"
import { BoatApiError, createBoatClient, type BoatFetch } from "./boat-client"
import { isTransientDriverError } from "./transient-error"
import { boatContainerSecurity, type BoatContainerSecurity } from "./boat-security"

// Boat (https://boat.dev) runs persistent Linux microVMs with Docker on the
// VM's own kernel but no workspace-runtime baked in, so this driver delivers
// the canonical sandbox OCI image by `docker run`-ing it inside the sandbox
// and publishes the runtime port with Boat's in-sandbox `host` command. The
// control plane reaches that URL over the relay like the other remote drivers.

export type { BoatFetch }

export type BoatSandboxDriverOptions = {
  apiKey: string
  baseUrl?: string
  image: string
  runtimePort?: number
  runtimeCommand?: string
  workspaceDir?: string
  nativeHarness?: string
  controlEnv?: WorkspaceRuntimeControlEnv
  /** Container name used for the runtime container inside the sandbox. */
  containerName?: string
  /**
   * Boat archives a sandbox after this many seconds. `null` (default) disables
   * it so the SandboxManager owns the lifecycle.
   */
  ttlSeconds?: number | null
  /**
   * Optional `docker login` before the pull, for a private runtime registry.
   * Omit for public images.
   */
  registryAuth?: { server: string; username: string; password: string }
  env?: (input: SandboxDriverEnsureInput, host: { id: string }) => Record<string, string> | Promise<Record<string, string>>
  provisionTimeoutMs?: number
  provisionIntervalMs?: number
  healthTimeoutMs?: number
  healthIntervalMs?: number
  operationTimeoutMs?: number
  fetchImpl?: BoatFetch
}

const DEFAULT_RUNTIME_COMMAND = "/usr/local/bin/workspace-runtime"
const DEFAULT_WORKSPACE_DIR = "/workspace"
const DEFAULT_CONTAINER_NAME = "claxedo-runtime"
const DEFAULT_PROVISION_TIMEOUT_MS = 120_000
const DEFAULT_PROVISION_INTERVAL_MS = 2_000
const DEFAULT_HEALTH_TIMEOUT_MS = 60_000
const DEFAULT_HEALTH_INTERVAL_MS = 1_000
// An image pull needs Boat's documented command maximum.
const CONTAINER_START_TIMEOUT_SECONDS = 600
const DOCKER_DAEMON_WAIT_SECONDS = 120
// Written via PUT /sandboxes/{id}/files — the provider's file channel — so env
// and registry credentials never appear in a /commands body, which Boat
// executes and can log. Paths are relative to the sandbox work directory,
// where commands also start; the container reads the env through a read-only
// bind mount.
const RUNTIME_ENV_PATH = ".claxedo-runtime-env"
const RUNTIME_ENV_STAGING_PATH = ".claxedo-runtime-env.stage"
const REGISTRY_PASSWORD_PATH = ".claxedo-registry-password"
const CONTAINER_ENV_PATH = "/run/claxedo-runtime.env"
// Everything the runtime keeps lives under one root on the VM's disk: the
// workspace, and the two home directories the image's runtime writes its
// stores, harness homes and state to (`~/.claxedo`, `~/.workspace-runtime`;
// the image runs as root). These bind sources are never created by the start
// command, which runs as the VM user: Docker creates a missing `-v` source as
// root, the container's user, and git refuses a workspace another uid owns.
const PERSISTENT_ROOT = "claxedo-persistent"
const PERSISTENT_HOME_MOUNTS = [["claxedo", "/root/.claxedo"], ["workspace-runtime", "/root/.workspace-runtime"]] as const

const STDERR_TAIL_CHARS = 600
const REDACTED_VALUE_MIN_LENGTH = 8

const READY_STATES = new Set(["ready", "idle", "running"])
const PENDING_STATES = new Set(["init", "provisioning", "provisioned", "cloning"])

/** Create is idempotent under its key, so a lost acknowledgement or a create still in flight is retried. */
const TRANSIENT_MARKERS = ["transport_failed", "idempotency_in_progress"] as const

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Redacts before bounding, so a secret the tail would cut in half is already
 * gone. Values shorter than the floor (ports, flags) are left readable.
 */
function scrubbedTail(text: string, secrets: readonly string[]) {
  const redacted = secrets
    .filter((secret) => secret.length >= REDACTED_VALUE_MIN_LENGTH)
    .reduce((output, secret) => output.split(secret).join("[redacted]"), text)
  return redacted.trim().slice(-STDERR_TAIL_CHARS)
}

class BoatDriverError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BoatDriverError"
  }
}

export function createBoatSandboxDriver(options: BoatSandboxDriverOptions): SandboxDriver {
  const client = createBoatClient({
    apiKey: options.apiKey,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.operationTimeoutMs ? { timeoutMs: options.operationTimeoutMs } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  })
  const runtimeCommand = options.runtimeCommand ?? DEFAULT_RUNTIME_COMMAND
  const workspaceDir = options.workspaceDir ?? DEFAULT_WORKSPACE_DIR
  const containerName = options.containerName ?? DEFAULT_CONTAINER_NAME
  const ttlSeconds = options.ttlSeconds === undefined ? null : options.ttlSeconds
  const provisionTimeoutMs = options.provisionTimeoutMs ?? DEFAULT_PROVISION_TIMEOUT_MS
  const provisionIntervalMs = options.provisionIntervalMs ?? DEFAULT_PROVISION_INTERVAL_MS
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS
  const healthIntervalMs = options.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS

  function runtimePort(input: SandboxDriverEnsureInput) {
    return input.workspaceRuntimePort ?? options.runtimePort ?? DEFAULT_WORKSPACE_RUNTIME_PORT
  }

  function workspaceDirectory(input: SandboxDriverEnsureInput) {
    return input.workspaceRoot ?? workspaceDir
  }

  function resolveImage(input: SandboxDriverEnsureInput) {
    return assertSandboxImageReference(
      input.bootSource?.kind === "image" ? input.bootSource.image : input.snapshot ?? options.image,
    )
  }

  function bootEnv(input: SandboxDriverEnsureInput, hostId: string): Record<string, string> {
    return workspaceRuntimeBootEnv({
      workspaceId: input.workspaceId,
      hostId,
      directory: workspaceDirectory(input),
      port: runtimePort(input),
      host: "0.0.0.0",
      source: input.source,
      env: input.env,
      nativeHarness: options.nativeHarness,
      controlEnv: options.controlEnv,
    })
  }

  async function execOrThrow(
    sandboxId: string,
    command: string,
    label: string,
    input: { timeoutSeconds?: number; secrets?: readonly string[] } = {},
  ) {
    const result = await client.command(sandboxId, { command, ...(input.timeoutSeconds ? { timeoutSeconds: input.timeoutSeconds } : {}) })
    if (result.timedOut || result.exitCode !== 0) {
      const outcome = result.timedOut ? "timed out" : `failed (exit ${result.exitCode ?? "signal"})`
      const stderr = scrubbedTail(result.stderr, input.secrets ?? [])
      throw new BoatDriverError(`Boat ${sandboxId} ${label} ${outcome}${stderr ? `: ${stderr}` : ""}`)
    }
    return result
  }

  async function waitUntilReady(sandboxId: string): Promise<boolean> {
    const until = Date.now() + provisionTimeoutMs
    for (;;) {
      const sandbox = await client.get(sandboxId)
      if (READY_STATES.has(sandbox.state)) return true
      if (!PENDING_STATES.has(sandbox.state)) {
        throw new BoatDriverError(`Boat ${sandboxId} entered non-ready state: ${sandbox.state}`)
      }
      if (Date.now() >= until) return false
      await sleep(provisionIntervalMs)
    }
  }

  /**
   * The command carries only paths: env arrives through the staged file
   * (mounted read-only, sourced by the entrypoint at every container start so
   * multi-line values like PEMs survive — `docker run --env-file` cannot
   * express them), and the registry password is piped to `docker login` from a
   * file that is removed whatever the outcome; a failed login aborts the chain.
   *
   * A resume reboots the VM: Docker comes up as a systemd service after
   * Boat reports the sandbox ready, so the chain waits for the daemon. Boat
   * then recreates the containers that were running, pulling their images
   * again (docs.boat.dev/snapshots, "What is captured"), while the driver
   * boots the runtime too. A container with the desired image, init, policy
   * identity and boot command is reused. A restored older configuration of
   * this image and command is replaced once if it wins the creation race.
   * The workspace and the runtime's own state
   * are bind-mounted from the sandbox filesystem the snapshot keeps.
   */
  function containerStartScript(input: SandboxDriverEnsureInput, security: BoatContainerSecurity): string {
    const port = runtimePort(input)
    const directory = workspaceDirectory(input)
    const image = shell(resolveImage(input))
    const bootScript = [
      `. ${CONTAINER_ENV_PATH}`,
      `mkdir -p ${shell(directory)}`,
      `chown "$(id -u):$(id -g)" ${shell(directory)}`,
      `cd ${shell(directory)}`,
      `exec ${runtimeCommand}`,
    ].join(" && ")
    const mounts = [["workspace", directory], ...PERSISTENT_HOME_MOUNTS]
    const run = `docker run -d --init --name ${containerName} -p ${port}:${port} `
      + `${security.args} `
      + `-v "$(pwd)/${RUNTIME_ENV_PATH}:${CONTAINER_ENV_PATH}:ro" `
      + mounts.map(([source, target]) => `-v "$(pwd)/${PERSISTENT_ROOT}/${source}":${shell(target)} `).join("")
      + `--entrypoint sh ${image} -lc ${shell(bootScript)}`
    const identity = shell(`${resolveImage(input)} true ${security.identity} -lc ${bootScript}`)
    const ours = `[ "$(docker inspect --format '{{.Config.Image}} {{.HostConfig.Init}} {{index .Config.Labels "claxedo.runtime.security"}} {{join .Config.Cmd " "}}' ${containerName} 2>/dev/null)" = ${identity} ]`
    const sameBoot = `[ "$(docker inspect --format '{{.Config.Image}} {{join .Config.Cmd " "}}' ${containerName} 2>/dev/null)" = ${shell(`${resolveImage(input)} -lc ${bootScript}`)} ]`
    const replace = `{ docker rm -f ${containerName} >/dev/null 2>&1 || true; } && ${run}`
    const steps = [
      `chmod 600 ${RUNTIME_ENV_STAGING_PATH}`,
      `sudo -n install -m 600 -o 0 -g 0 ${RUNTIME_ENV_STAGING_PATH} ${RUNTIME_ENV_PATH}`,
      `rm -f ${RUNTIME_ENV_STAGING_PATH}`,
      `timeout ${DOCKER_DAEMON_WAIT_SECONDS} sh -c 'until docker info >/dev/null 2>&1; do sleep 1; done'`,
      security.prepare,
      ...(options.registryAuth
        ? [`{ chmod 600 ${REGISTRY_PASSWORD_PATH}; docker login ${shell(options.registryAuth.server)} `
          + `--username ${shell(options.registryAuth.username)} --password-stdin < ${REGISTRY_PASSWORD_PATH}; `
          + `rc=$?; rm -f ${REGISTRY_PASSWORD_PATH}; (exit $rc); }`]
        : []),
      `{ docker image inspect ${image} >/dev/null 2>&1 || docker pull ${image}; }`,
      `if ${ours}; then docker start ${containerName} >/dev/null; `
      + `else { ${replace}; } || { ${ours} && docker start ${containerName} >/dev/null; } `
      + `|| { ${sameBoot} && { ${replace}; }; }; fi`,
    ]
    return steps.join(" && ")
  }

  async function waitForHealth(sandboxId: string, input: SandboxDriverEnsureInput, secrets: readonly string[]) {
    const port = runtimePort(input)
    const until = Date.now() + healthTimeoutMs
    let last = "workspace runtime not ready"
    while (Date.now() < until) {
      const probe = await client.command(sandboxId, {
        command: `curl -sf -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/global/health || true`,
      })
      const code = trimToUndefined(probe.stdout)
      if (code === "200") return
      last = `health probe returned ${code ?? "no response"}`
      await sleep(healthIntervalMs)
    }
    let diagnostic: string
    try {
      const result = await client.command(sandboxId, {
        command: `docker inspect --format 'status={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}}' ${shell(containerName)}; docker logs --tail 20 ${shell(containerName)} 2>&1`,
        timeoutSeconds: 10,
      })
      diagnostic = scrubbedTail(`${result.stdout}\n${result.stderr}`, secrets)
    } catch {
      diagnostic = "container diagnostics unavailable"
    }
    throw new BoatDriverError(`Boat ${sandboxId} runtime did not become healthy: ${last}; ${diagnostic}`)
  }

  async function startContainer(sandboxId: string, input: SandboxDriverEnsureInput, hostId: string) {
    const env = { ...bootEnv(input, hostId), ...(await options.env?.(input, { id: hostId })) }
    const security = await boatContainerSecurity()
    const script = containerStartScript(input, security)
    for (const file of security.files) await client.writeFile(sandboxId, file)
    await client.writeFile(sandboxId, { path: RUNTIME_ENV_STAGING_PATH, content: envFile(env) })
    if (options.registryAuth) {
      await client.writeFile(sandboxId, { path: REGISTRY_PASSWORD_PATH, content: options.registryAuth.password })
    }
    const secrets = [...Object.values(env), ...(options.registryAuth ? [options.registryAuth.password] : [])]
    const failures: unknown[] = []
    try {
      await execOrThrow(sandboxId, script, "container start", { timeoutSeconds: CONTAINER_START_TIMEOUT_SECONDS, secrets })
    } catch (error) {
      failures.push(error)
    }
    // The login step removes the staged password when it runs; this covers
    // failures before the command reaches it.
    try {
      if (options.registryAuth) await execOrThrow(sandboxId, `rm -f ${REGISTRY_PASSWORD_PATH}`, "registry password cleanup", { secrets })
    } catch (error) {
      failures.push(error)
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, `Boat ${sandboxId} container start and registry password cleanup failed`)
    return secrets
  }

  async function boot(sandboxId: string, input: SandboxDriverEnsureInput, hostId: string): Promise<SandboxTarget> {
    const port = runtimePort(input)
    const secrets = await startContainer(sandboxId, input, hostId)
    await input.onImageReady?.()
    // Boat gates a hosted port behind a `_token` query, and `host url` prints
    // the gated URL again unless it also carries `--public`. The relay joins
    // request paths onto this base URL and would drop that query, so the
    // runtime authenticates every route itself except the anonymous
    // `/global/health` probe (liveness, the workspace id and the lease epoch).
    await execOrThrow(sandboxId, `host ${port} --public`, "host publish")
    await waitForHealth(sandboxId, input, secrets)
    const urlResult = await execOrThrow(sandboxId, `host url ${port} --public`, "host url")
    const url = trimToUndefined(urlResult.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop())
    if (!url?.startsWith("https://") || url.includes("?")) {
      throw new BoatDriverError(`Boat ${sandboxId} did not return an ungated HTTPS URL for port ${port}`)
    }
    return {
      workspaceId: input.workspaceId,
      sandboxId,
      url,
      hostId,
      driverResourceId: sandboxId,
      driver: { id: "boat", resourceId: sandboxId },
      labels: input.labels,
    }
  }

  function assertNetwork(input: SandboxDriverEnsureInput) {
    if (input.net && input.net.mode !== "allow-all") {
      throw new BoatDriverError("Boat SandboxDriver cannot enforce host-based network policy")
    }
  }

  async function ensureHost(input: SandboxDriverEnsureInput) {
    assertNetwork(input)
    const hostId = input.hostId ?? `boat-${input.workspaceId}`
    const created = await client.create({ idempotencyKey: `claxedo:${input.workspaceId}:${input.epoch}`, ttlSeconds })
      .catch((err: unknown) => {
        if (isTransientDriverError(err, TRANSIENT_MARKERS)) return undefined
        throw err
      })
    if (!created) return { provisioning: true as const, retryAfterMs: provisionIntervalMs }
    const resource = { sandboxId: created.id, hostId, driverResourceId: created.id, labels: input.labels }
    const failures: unknown[] = []
    try {
      await input.onResource?.(resource)
    } catch (handoffError) {
      failures.push(handoffError)
      try {
        await destroy({ ...resource, workspaceId: input.workspaceId })
      } catch (deleteError) {
        failures.push(deleteError)
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, `Boat ${created.id} resource handoff and deletion failed`)
    const ready = await waitUntilReady(created.id)
    if (!ready) return { provisioning: true as const, retryAfterMs: provisionIntervalMs }
    return boot(created.id, input, hostId)
  }

  async function resumeHost(input: { lease: SandboxLease; ensure: SandboxDriverEnsureInput }) {
    const sandboxId = input.lease.sandboxId
    if (!sandboxId) throw new BoatDriverError("Cannot resume Boat without its sandbox id")
    assertNetwork(input.ensure)
    const hostId = input.ensure.hostId ?? input.lease.hostId ?? `boat-${input.ensure.workspaceId}`
    if (input.lease.url !== undefined) await client.resume(sandboxId, { ttlSeconds })
    const ready = await waitUntilReady(sandboxId)
    if (!ready) return { provisioning: true as const, retryAfterMs: provisionIntervalMs }
    return boot(sandboxId, input.ensure, hostId)
  }

  async function stop(target: SandboxTarget) {
    await client.stop(target.sandboxId)
  }

  async function destroy(target: SandboxResource) {
    try {
      await client.delete(target.sandboxId)
    } catch (error) {
      if (error instanceof BoatApiError && error.status === 404) return
      throw error
    }
    const until = Date.now() + provisionTimeoutMs
    for (;;) {
      try {
        await client.get(target.sandboxId)
      } catch (error) {
        if (error instanceof BoatApiError && error.status === 404) return
        throw error
      }
      if (Date.now() >= until) throw new BoatDriverError(`Boat ${target.sandboxId} deletion did not complete`)
      await sleep(provisionIntervalMs)
    }
  }

  return {
    id: "boat",
    metadata: sandboxDriverCatalog.boat.metadata,
    ensureHost,
    resumeHost,
    async touch() {},
    suspend: stop,
    stop,
    destroy,
  }
}
