import { trimToUndefined } from "@claxedo/helpers/string"
import {
  SANDBOX_IMAGE_LABEL,
  type SandboxDriver,
  type SandboxDriverEnsureInput,
  type SandboxLease,
  type SandboxHostState,
  type SandboxTarget,
  type SandboxResource,
} from "../contract"
import { SandboxHostGoneError, SandboxRuntimeBootError, runtimeBootDiagnostic } from "../lease-failure"
import { workspaceRuntimeBootEnv, workspaceRuntimeBootSecrets, type WorkspaceRuntimeControlEnv } from "../runtime-env"
import { envFile, shell } from "../command"
import { DEFAULT_WORKSPACE_RUNTIME_PORT } from "../constants"
import { assertSandboxImageReference } from "../image-name"
import { sandboxDriverCatalog } from "../driver-catalog"
import { BoatApiError, createBoatClient, type BoatFetch, type BoatSandboxState } from "./boat-client"
import { isTransientDriverError, TRANSIENT_DRIVER_RETRY_MS } from "./transient-error"
import { record } from "../json"
import {
  bootedImage,
  CONTAINER_START_TIMEOUT_SECONDS,
  DEFAULT_CONTAINER_NAME,
  holdingBootLock,
  IMAGE_PREPARATION_TIMEOUT_SECONDS,
  machineBootScripts,
  REGISTRY_PASSWORD_PATH,
  RUNTIME_ENV_PATH,
  bootedImageFile,
  type StagedFiles,
} from "./boat-machine"

// Boat (https://boat.dev) runs persistent Linux microVMs with Docker on the
// VM's own kernel but no workspace-runtime baked in, so the canonical sandbox
// OCI image is unpacked onto the VM's disk, by this driver or ahead of time in
// the release's runtime template a sandbox is created from; the runtime runs
// inside the sandbox as a container of a stub image over those trees, and its
// port is published with Boat's in-sandbox `host` command. The control plane
// reaches that URL over the relay like the other remote drivers.

export type { BoatFetch }

/**
 * A named snapshot of a machine that already holds `image`'s trees, stub and
 * env, and Boat's record of the files the runtime opens first; another Boat
 * account creates a sandbox from it with the share code.
 */
export type BoatRuntimeTemplate = { image: string; shareCode: string }

export function formatBoatRuntimeTemplate(template: BoatRuntimeTemplate) {
  return JSON.stringify({ image: template.image, shareCode: template.shareCode })
}

export function parseBoatRuntimeTemplate(setting: string): BoatRuntimeTemplate {
  let value: unknown
  try {
    value = JSON.parse(setting)
  } catch {
    throw new BoatDriverError("A Boat runtime template is JSON naming its image and share code")
  }
  const { image, shareCode } = record(value) ?? {}
  if (typeof shareCode !== "string" || !/^bsh_\S+$/.test(shareCode) || typeof image !== "string") {
    throw new BoatDriverError("A Boat runtime template names its image and a bsh_ share code")
  }
  return { image: assertSandboxImageReference(image), shareCode }
}

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
   * Optional `docker login` before the pull, for a private runtime registry.
   * Omit for public images.
   */
  registryAuth?: { server: string; username: string; password: string }
  /** Creates a sandbox that boots the template's image from the template instead of pulling and seeding the image. */
  runtimeTemplate?: BoatRuntimeTemplate
  env?: (input: SandboxDriverEnsureInput, host: { id: string }) => Record<string, string> | Promise<Record<string, string>>
  provisionTimeoutMs?: number
  /** The first and the longest wait between two reads of a sandbox's state, where Boat offers no wait. */
  statePollMs?: { firstMs: number; maxMs: number }
  healthTimeoutMs?: number
  healthIntervalMs?: number
  operationTimeoutMs?: number
  fetchImpl?: BoatFetch
}

const DEFAULT_RUNTIME_COMMAND = "/usr/local/bin/workspace-runtime"
const DEFAULT_WORKSPACE_DIR = "/workspace"
const DEFAULT_PROVISION_TIMEOUT_MS = 120_000
// Boat's stop has no blocking form or stream (docs.boat.dev/snapshots/stop),
// and an archive took 13–27 s (2026-10-15), so a stop under way is read
// again from a short first wait growing to 2 s: 30 reads a minute against
// Boat's 1,000 requests a minute per IP (docs.boat.dev/limits), which every
// organization's sandboxes share from the control plane's addresses.
const DEFAULT_STATE_POLL_MS = { firstMs: 250, maxMs: 2_000 }
// The runtime listens only after its checkout and the repository's own
// scripts; a container that exited ends the wait at once instead.
const DEFAULT_HEALTH_TIMEOUT_MS = 10 * 60_000
// Probed inside the VM, so a probe costs a local curl and a `docker inspect`,
// and no Boat request.
const DEFAULT_HEALTH_INTERVAL_MS = 100
// One health command probes for this long before it answers; a longer one
// would only delay a timed-out wait's diagnostics.
const HEALTH_PROBE_WINDOW_SECONDS = 50
const HEALTH_PROBE_MARGIN_SECONDS = 10
// Boat pauses a new sandbox's containers for about a second while it takes the
// sandbox's first snapshot, 2 s into the runtime's start; the runtime resumes on its own.
const BOOTING_CONTAINER_STATES: ReadonlySet<string> = new Set(["running", "paused"])
const HOST_PUBLISH_TIMEOUT_SECONDS = 120
// Boat's auto-stop is a deadline counted from the create or resume, not from
// use (docs.boat.dev/long-running-tasks/auto-stop), so a serving sandbox
// carries none and the control plane's own idle stop ends it. A boot nobody
// drives to its end — the start that began it died with its Worker — is
// archived by Boat at this deadline instead, which outlasts the longest boot
// (two minutes to provision, ten to pull and start, ten to turn healthy).
const BOOT_TTL_SECONDS = 30 * 60
// Boat gives a container 30 s to exit at its own stop (docs.boat.dev/snapshots/stop).
const CONTAINER_STOP_GRACE_SECONDS = 30

// Boat's own answer to a `host` it could not complete, which asks for another try (2026-10-15).
const HOST_RELAY_NOT_STOPPED = "The sandbox could not stop the localhost relay of this port. Try again."

const STDERR_TAIL_CHARS = 600
const REDACTED_VALUE_MIN_LENGTH = 8

const READY_STATES = new Set(["ready", "idle", "running"])
const PENDING_STATES = new Set(["init", "provisioning", "provisioned", "cloning"])

/** Create is idempotent under its key, so a lost acknowledgement or a create still in flight is retried. */
const TRANSIENT_MARKERS = ["transport_failed", "idempotency_in_progress"] as const
/** Boat's answers for a sandbox it no longer has: deleted, or stopped so long its disk was dropped (docs.boat.dev/snapshots/stop). */
const GONE_CODES: ReadonlySet<string> = new Set(["not_found", "snapshot_data_expired"])
const RESUME_UNDER_WAY = "sandbox_resuming"
/**
 * Boat's answers for a sandbox whose machine is not running: `sandbox_not_ready`
 * is its documented one for a stopped sandbox (docs.boat.dev, execute command),
 * and `machine_not_running` the one it gave a command on an archived sandbox
 * (staging, 2026-10-15).
 */
const NOT_RUNNING_CODES: ReadonlySet<string> = new Set(["machine_not_running", "sandbox_not_ready"])
/**
 * Boat's answers for a template this key cannot create from: a wrong, revoked
 * or removed share code, or a key without `snapshot.read`
 * (docs.boat.dev/snapshots/templates, docs.boat.dev/api-keys/scopes).
 */
const TEMPLATE_UNREADABLE_CODES: ReadonlySet<string> = new Set(["snapshot_not_found", "api_key_action_forbidden", "api_key_sandbox_forbidden"])


function hostGoneOrThrow(err: unknown): never {
  if (err instanceof BoatApiError && GONE_CODES.has(err.code)) throw new SandboxHostGoneError(err.message)
  throw err
}

function notRunningOrThrow(err: unknown): void {
  if (err instanceof BoatApiError && NOT_RUNNING_CODES.has(err.code)) return
  hostGoneOrThrow(err)
}

/** Boat refuses to stop a sandbox it has archived with a 400 `stop_failed` naming the sandbox `archived`; one archiving answers 202 (2026-10-17). */
function archivedOrThrow(err: unknown): void {
  if (err instanceof BoatApiError && err.code === "stop_failed" && err.sandboxState === "archived") return
  hostGoneOrThrow(err)
}


function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Redacts before bounding, so a secret the bound would cut in half is already
 * gone. Values shorter than the floor (ports, flags) are left readable.
 */
function scrubbed(text: string, secrets: readonly string[]) {
  return secrets
    .filter((secret) => secret.length >= REDACTED_VALUE_MIN_LENGTH)
    .reduce((output, secret) => output.split(secret).join("[redacted]"), text)
}

function scrubbedTail(text: string, secrets: readonly string[]) {
  return scrubbed(text, secrets).trim().slice(-STDERR_TAIL_CHARS)
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
  const provisionTimeoutMs = options.provisionTimeoutMs ?? DEFAULT_PROVISION_TIMEOUT_MS
  const statePollMs = options.statePollMs ?? DEFAULT_STATE_POLL_MS
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
    input: { timeoutSeconds?: number; secrets?: readonly string[]; retryOnceOn?: string } = {},
  ) {
    const send = () => client.command(sandboxId, { command, ...(input.timeoutSeconds ? { timeoutSeconds: input.timeoutSeconds } : {}) })
    let result = await send()
    if (input.retryOnceOn && result.exitCode !== 0 && result.stderr.includes(input.retryOnceOn)) result = await send()
    if (result.timedOut || result.exitCode !== 0) {
      const outcome = result.timedOut ? "timed out" : `failed (exit ${result.exitCode ?? "signal"})`
      const stderr = scrubbedTail(result.stderr, input.secrets ?? [])
      throw new BoatDriverError(`Boat ${sandboxId} ${label} ${outcome}${stderr ? `: ${stderr}` : ""}`)
    }
    return result
  }

  /**
   * Boat holds a command sent while the sandbox starts and runs it once the
   * sandbox is ready, so the first command that runs is the readiness Boat
   * itself knows, with no read between. A command Boat refuses outright finds
   * a sandbox that is not starting; its state says whether it is still coming,
   * and one that reads as coming is asked again at the slowest state read's pace.
   */
  async function waitUntilReady(sandboxId: string): Promise<boolean> {
    const until = Date.now() + provisionTimeoutMs
    for (;;) {
      const answer = await client.whenReady(sandboxId).catch(async (err: unknown) => {
        if (!(err instanceof BoatApiError && NOT_RUNNING_CODES.has(err.code))) hostGoneOrThrow(err)
        const { state } = await client.get(sandboxId).catch(hostGoneOrThrow)
        if (!READY_STATES.has(state) && !PENDING_STATES.has(state)) throw new BoatDriverError(`Boat ${sandboxId} entered non-ready state: ${state}`)
        await sleep(statePollMs.maxMs)
        return "starting" as const
      })
      if (answer === "ready") return true
      if (Date.now() >= until) return false
    }
  }

  /** The sandbox's state once Boat has finished archiving it; nothing when the archive outlasts the provisioning window. */
  async function stateAfterArchiving(sandboxId: string): Promise<BoatSandboxState | undefined> {
    const until = Date.now() + provisionTimeoutMs
    let wait = statePollMs.firstMs
    for (;;) {
      const { state } = await client.get(sandboxId).catch(hostGoneOrThrow)
      if (state !== "archiving") return state
      if (Date.now() >= until) return undefined
      await sleep(wait)
      wait = Math.min(wait * 2, statePollMs.maxMs)
    }
  }

  /**
   * Probes inside the VM until the runtime answers, its container leaves the
   * booting states, or the probe's window ends, then prints the last health
   * code and container state: the wait ends within one probe interval of the
   * runtime's first answer, at one Boat command per window.
   */
  function healthProbe(port: number, windowSeconds: number) {
    const booting = [...BOOTING_CONTAINER_STATES].join("|")
    return `end=$(($(date +%s) + ${windowSeconds})); while :; do `
      + `code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/global/health); [ "$code" = 200 ] && break; `
      + `state=$(docker inspect --format '{{.State.Status}}' ${shell(containerName)} 2>/dev/null || echo missing); `
      + `case "$state" in ${booting}) ;; *) break ;; esac; `
      + `[ "$(date +%s)" -lt "$end" ] || break; sleep ${healthIntervalMs / 1000}; done; echo "$code"; echo "$state"`
  }

  async function waitForHealth(sandboxId: string, input: SandboxDriverEnsureInput, secrets: readonly string[]) {
    const port = runtimePort(input)
    const until = Date.now() + healthTimeoutMs
    let last = "workspace runtime not ready"
    while (Date.now() < until) {
      const windowSeconds = Math.max(1, Math.min(HEALTH_PROBE_WINDOW_SECONDS, Math.ceil((until - Date.now()) / 1000)))
      const probe = await client.command(sandboxId, {
        command: healthProbe(port, windowSeconds),
        timeoutSeconds: windowSeconds + HEALTH_PROBE_MARGIN_SECONDS,
      })
      const [code, state] = probe.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      if (code === "200") return
      last = `health probe returned ${code || "no response"}`
      if (state !== undefined && !BOOTING_CONTAINER_STATES.has(state)) {
        last = `the runtime container is ${state}`
        break
      }
    }
    let diagnostic: string
    try {
      const result = await client.command(sandboxId, {
        command: `docker inspect --format 'status={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}}' ${shell(containerName)}; docker logs --tail 20 ${shell(containerName)} 2>&1`,
        timeoutSeconds: 10,
      })
      diagnostic = runtimeBootDiagnostic(scrubbed(`${result.stdout}\n${result.stderr}`, secrets), STDERR_TAIL_CHARS)
    } catch {
      diagnostic = "container diagnostics unavailable"
    }
    throw new SandboxRuntimeBootError(`Boat ${sandboxId} runtime did not become healthy: ${last}; ${diagnostic}`)
  }

  async function startContainer(sandboxId: string, input: SandboxDriverEnsureInput, hostId: string, keepPreviousImage: boolean) {
    const env = { ...bootEnv(input, hostId), ...(await options.env?.(input, { id: hostId })) }
    const boot = crypto.randomUUID()
    const staged: StagedFiles = {
      env: `${RUNTIME_ENV_PATH}.${boot}`,
      ...(options.registryAuth ? { password: `${REGISTRY_PASSWORD_PATH}.${boot}` } : {}),
    }
    const image = resolveImage(input)
    const scripts = machineBootScripts({
      image,
      keepPreviousImage: keepPreviousImage && image === options.image,
      workspaceId: input.workspaceId,
      directory: workspaceDirectory(input),
      port: runtimePort(input),
      runtimeCommand,
      containerName,
      ...(options.registryAuth ? { registry: { server: options.registryAuth.server, username: options.registryAuth.username } } : {}),
      staged,
      staleStagedMinutes: BOOT_TTL_SECONDS / 60,
    })
    await client.writeFile(sandboxId, { path: staged.env, content: envFile(env) })
    if (options.registryAuth && staged.password) {
      await client.writeFile(sandboxId, { path: staged.password, content: options.registryAuth.password })
    }
    const secrets = [...workspaceRuntimeBootSecrets(env), ...(options.registryAuth ? [options.registryAuth.password] : [])]
    let failure: unknown
    let booted: string | undefined
    try {
      const prepared = await execOrThrow(sandboxId, scripts.prepare, "runtime image preparation", { timeoutSeconds: IMAGE_PREPARATION_TIMEOUT_SECONDS, secrets })
      booted = bootedImage(prepared.stdout)
      if (!booted) throw new BoatDriverError(`Boat ${sandboxId} runtime image preparation named no image it booted`)
      try {
        await execOrThrow(sandboxId, scripts.start, "container start", { timeoutSeconds: CONTAINER_START_TIMEOUT_SECONDS, secrets })
      } catch (error) {
        // The container of the previous image is gone by now, so the lease
        // has nothing serving: a boot failure, which the manager demotes,
        // unlike a provider error over a runtime that may still serve.
        throw error instanceof BoatDriverError ? new SandboxRuntimeBootError(error.message) : error
      }
    } catch (error) {
      failure = error
    }
    // The login step removes the staged password and the start moves the
    // staged env into place when they run; this covers failures before then.
    // A cleanup that fails after the boot did is told in the boot's own error,
    // which keeps its kind and is the text the lease records.
    try {
      if (options.registryAuth || failure !== undefined) {
        await execOrThrow(sandboxId, `rm -f ${[staged.env, staged.password, bootedImageFile(staged)].filter(Boolean).join(" ")}`, "staged file cleanup", { secrets })
      }
    } catch (cleanupFailure) {
      if (failure === undefined) throw cleanupFailure
      if (failure instanceof Error) failure.message = `${failure.message}; ${cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure)}`
    }
    if (failure !== undefined || !booted) throw failure
    return { secrets, booted }
  }

  async function boot(sandboxId: string, input: SandboxDriverEnsureInput, hostId: string, keepPreviousImage: boolean): Promise<SandboxTarget> {
    await input.onMachineReady?.()
    const port = runtimePort(input)
    const { secrets, booted } = await startContainer(sandboxId, input, hostId, keepPreviousImage)
    await input.onImageReady?.()
    // Boat gates a hosted port behind a `_token` query, and `host url` prints
    // the gated URL again unless it also carries `--public`. The relay joins
    // request paths onto this base URL and would drop that query, so the
    // runtime authenticates every route itself except the anonymous
    // `/global/health` probe (liveness, the workspace id and the lease epoch).
    // Two boots publishing one port at once made Boat answer 500 on its own unique (agent, port) record (2026-10-15).
    await execOrThrow(sandboxId, holdingBootLock(HOST_PUBLISH_TIMEOUT_SECONDS, `host ${port} --public`), "host publish", {
      timeoutSeconds: HOST_PUBLISH_TIMEOUT_SECONDS,
      retryOnceOn: HOST_RELAY_NOT_STOPPED,
    })
    await waitForHealth(sandboxId, input, secrets)
    // The lease owns the sandbox's lifetime from here; a deadline Boat keeps
    // would end it mid-work, so a sandbox whose deadline cannot be removed
    // is not handed over.
    await client.update(sandboxId, { ttlSeconds: null })
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
      labels: { ...input.labels, ...(resolveImage(input) === options.image ? { [SANDBOX_IMAGE_LABEL]: booted } : {}) },
    }
  }

  function assertNetwork(input: SandboxDriverEnsureInput) {
    if (input.net && input.net.mode !== "allow-all") {
      throw new BoatDriverError("Boat SandboxDriver cannot enforce host-based network policy")
    }
  }

  /**
   * A template's create carries a key of its own: Boat refuses a key sent
   * again with another body for as long as it keeps the first (24 h), and a
   * refused template is followed by the create that pulls and seeds the image.
   */
  async function createSandbox(input: SandboxDriverEnsureInput) {
    const create = (from?: string) => client.create({
      idempotencyKey: `claxedo:${input.workspaceId}:${input.epoch}${from ? ":template" : ""}`,
      ttlSeconds: BOOT_TTL_SECONDS,
      ...(input.machineClass ? { type: input.machineClass } : {}),
      ...(from ? { from } : {}),
    })
    const template = options.runtimeTemplate
    if (!template || template.image !== resolveImage(input)) return create()
    try {
      return await create(template.shareCode)
    } catch (err) {
      if (!(err instanceof BoatApiError && TEMPLATE_UNREADABLE_CODES.has(err.code))) throw err
      console.warn(`Boat runtime template for ${template.image} is unreadable with this key (${err.code}); the sandbox pulls and seeds the image instead`)
      return create()
    }
  }

  async function ensureHost(input: SandboxDriverEnsureInput) {
    assertNetwork(input)
    const hostId = input.hostId ?? `boat-${input.workspaceId}`
    const created = await createSandbox(input)
      .catch((err: unknown) => {
        if (isTransientDriverError(err, TRANSIENT_MARKERS)) return undefined
        throw err
      })
    if (!created) return { provisioning: true as const, retryAfterMs: TRANSIENT_DRIVER_RETRY_MS }
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
    // The step itself waited the whole provisioning window, so the next one begins its wait at once.
    const ready = await waitUntilReady(created.id)
    if (!ready) return { provisioning: true as const, retryAfterMs: 0 }
    return boot(created.id, input, hostId, false)
  }

  async function resumeHost(input: { lease: SandboxLease; ensure: SandboxDriverEnsureInput }) {
    const sandboxId = input.lease.sandboxId
    if (!sandboxId) throw new BoatDriverError("Cannot resume Boat without its sandbox id")
    assertNetwork(input.ensure)
    const hostId = input.ensure.hostId ?? input.lease.hostId ?? `boat-${input.ensure.workspaceId}`
    // The lease does not say whether its sandbox is archived: one stopped
    // after serving is, one whose boot failed was stopped too, and one a
    // provider error interrupted still runs.
    const state = await stateAfterArchiving(sandboxId)
    if (state === undefined) return { provisioning: true as const, retryAfterMs: 0 }
    // Only a resume can move a sandbox to another size (docs.boat.dev/machines/change-size); a running one keeps its machine.
    if (state === "archived") {
      await client.resume(sandboxId, {
        ttlSeconds: BOOT_TTL_SECONDS,
        ...(input.ensure.machineClass ? { type: input.ensure.machineClass } : {}),
      }).catch((err: unknown) => {
        // Another boot of this workspace resumed it first; its resume brings the sandbox up for both.
        if (err instanceof BoatApiError && err.code === RESUME_UNDER_WAY) return
        hostGoneOrThrow(err)
      })
    }
    const ready = await waitUntilReady(sandboxId)
    if (!ready) return { provisioning: true as const, retryAfterMs: 0 }
    return boot(sandboxId, input.ensure, hostId, !input.ensure.updateImage)
  }

  /**
   * The container is ended before Boat archives the sandbox and kept, so the
   * snapshot records it as stopped: Boat's restore creates it again without
   * starting it (docs.boat.dev/snapshots/whats-saved#docker), and the start
   * starts it after writing this boot's env file. Removed, it left Boat the
   * set an earlier snapshot recorded, from which Boat created and started the
   * runtime again on the previous boot's env file (2026-10-15). The runtime
   * gets the grace Boat's own stop gives. A machine that is not running holds
   * no running container and is already stopped, which is what a stop asks.
   */
  async function stop(target: SandboxResource) {
    await client.command(target.sandboxId, {
      command: `docker stop -t ${CONTAINER_STOP_GRACE_SECONDS} ${containerName} >/dev/null 2>&1; true`,
      timeoutSeconds: CONTAINER_STOP_GRACE_SECONDS + 30,
    }).then(() => undefined, notRunningOrThrow)
    await client.stop(target.sandboxId).catch(archivedOrThrow)
  }

  async function destroy(target: SandboxResource) {
    await client.delete(target.sandboxId)
  }

  async function inspect(target: SandboxTarget): Promise<SandboxHostState> {
    try {
      const { state } = await client.get(target.sandboxId)
      return READY_STATES.has(state) || PENDING_STATES.has(state) ? "serving" : "stopped"
    } catch (err) {
      if (err instanceof BoatApiError && GONE_CODES.has(err.code)) return "gone"
      throw err
    }
  }

  return {
    id: "boat",
    metadata: sandboxDriverCatalog.boat.metadata,
    image: options.image,
    ensureHost,
    resumeHost,
    async touch() {},
    suspend: stop,
    stop,
    destroy,
    inspect,
  }
}
