import { trimToUndefined } from "@claxedo/helpers/string"
import {
  SANDBOX_IMAGE_LABEL,
  type SandboxDriver,
  type SandboxDriverEnsureInput,
  type SandboxLease,
  type SandboxTarget,
  type SandboxResource,
} from "../contract"
import { SandboxHostGoneError, SandboxRuntimeBootError } from "../lease-failure"
import { workspaceRuntimeBootEnv, workspaceRuntimeBootSecrets, type WorkspaceRuntimeControlEnv } from "../runtime-env"
import { envFile, shell } from "../command"
import { DEFAULT_WORKSPACE_RUNTIME_PORT } from "../constants"
import { assertSandboxImageReference } from "../image-name"
import { sandboxDriverCatalog } from "../driver-catalog"
import { BoatApiError, createBoatClient, type BoatFetch } from "./boat-client"
import { isTransientDriverError } from "./transient-error"

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
// The runtime listens only after its checkout and the repository's own
// scripts; a container that exited ends the wait at once instead.
const DEFAULT_HEALTH_TIMEOUT_MS = 10 * 60_000
const DEFAULT_HEALTH_INTERVAL_MS = 1_000
// Boat pauses a new sandbox's containers for about a second while it takes the
// sandbox's first snapshot, 2 s into the runtime's start; the runtime resumes on its own.
const BOOTING_CONTAINER_STATES: ReadonlySet<string> = new Set(["running", "paused"])
// An image pull and the seed need Boat's documented command maximum.
const IMAGE_PREPARATION_TIMEOUT_SECONDS = 600
// The image is local by then; creating the container is seconds.
const CONTAINER_START_TIMEOUT_SECONDS = 120
// Boat's auto-stop is a deadline counted from the create or resume, not from
// use (docs.boat.dev/long-running-tasks/auto-stop), so a serving sandbox
// carries none and the control plane's own idle stop ends it. A boot nobody
// drives to its end — the start that began it died with its Worker — is
// archived by Boat at this deadline instead, which outlasts the longest boot
// (two minutes to provision, ten to pull and start, ten to turn healthy).
const BOOT_TTL_SECONDS = 30 * 60
const DOCKER_DAEMON_WAIT_SECONDS = 120
// Written via PUT /sandboxes/{id}/files — the provider's file channel — so env
// and registry credentials never appear in a /commands body, which Boat
// executes and can log. Paths are relative to the sandbox work directory,
// where commands also start; the container reads the env through a read-only
// bind mount.
const RUNTIME_ENV_PATH = ".claxedo-runtime-env"
const REGISTRY_PASSWORD_PATH = ".claxedo-registry-password"
const CONTAINER_ENV_PATH = "/run/claxedo-runtime.env"
// Everything the runtime keeps lives under one root on the VM's disk, which
// Boat's snapshot saves (docs.boat.dev/snapshots/whats-saved): the workspace,
// the two home directories the image's runtime writes its stores, harness
// homes and state to (`~/.claxedo`, `~/.workspace-runtime`; the image runs as
// root), and the image's own writable trees. The workspace bind source is
// never created by the start command, which runs as the VM user: Docker
// creates a missing `-v` source as root, the container's user, and git refuses
// a workspace another uid owns.
const PERSISTENT_ROOT = "claxedo-persistent"
const PERSISTENT_HOME_MOUNTS = [["claxedo", "/root/.claxedo"], ["workspace-runtime", "/root/.workspace-runtime"]] as const
// A container's writable layer is not part of a Boat snapshot, and Boat's own
// resume creates every container again from its image (docs.boat.dev/snapshots/whats-saved,
// "Docker"; measured 2026-10-14: a file written into the layer after the start
// was gone after one stop and resume). So the trees a Boat VM itself keeps
// across a stop are copied out of the image once per image, into bind sources
// the snapshot saves, and mounted over the image's: what a person or a harness
// installs or writes anywhere on the machine (apt, npm -g, pip, dotfiles) is
// there after a resume. An image update starts from the new image's trees and
// drops the old image's. Docker named volumes would seed themselves, but a stop
// with 3.7 GB of them did not finish within ten minutes, while the same bytes
// under the work directory archived in 27 s. Boat leaves ~/.cache out of its
// snapshots; so does the seed, with npm's cache beside it (0.9 GB of the image).
const IMAGE_TREES = ["root", "usr", "etc", "var", "opt", "home", "srv"] as const
const IMAGE_TREE_SEED_EXCLUDES = ["root/.cache", "root/.npm/_cacache"] as const
const IMAGE_TREES_COMPLETE_MARKER = ".complete"
const SEED_CONTAINER_NAME = "claxedo-seed"
const CONTAINER_SECURITY_OPTIONS = "--security-opt seccomp=unconfined --security-opt apparmor=unconfined"
// `--init` mounts Docker's init at /sbin/docker-init, which the image's merged
// /usr resolves into the bind-mounted /usr, where it does not exist; the VM's
// binary is mounted at a path of its own instead.
const VM_DOCKER_INIT = "/usr/libexec/docker/docker-init"
const CONTAINER_INIT_PATH = "/claxedo-init"
// Boat gives a container 30 s to exit at its own stop (docs.boat.dev/snapshots/stop).
const CONTAINER_STOP_GRACE_SECONDS = 30

const STDERR_TAIL_CHARS = 600
const REDACTED_VALUE_MIN_LENGTH = 8

const READY_STATES = new Set(["ready", "idle", "running"])
const PENDING_STATES = new Set(["init", "provisioning", "provisioned", "cloning"])

/** Create is idempotent under its key, so a lost acknowledgement or a create still in flight is retried. */
const TRANSIENT_MARKERS = ["transport_failed", "idempotency_in_progress"] as const
/** Boat's answers for a sandbox it no longer has: deleted, or stopped so long its disk was dropped (docs.boat.dev/snapshots/stop). */
const GONE_CODES: ReadonlySet<string> = new Set(["not_found", "snapshot_data_expired"])

function hostGoneOrThrow(err: unknown): never {
  if (err instanceof BoatApiError && GONE_CODES.has(err.code)) throw new SandboxHostGoneError(err.message)
  throw err
}

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

/** A directory name an image reference maps to, one per image; references differ in characters the mapping keeps. */
function imageTreesDirectory(image: string) {
  return `image-${image.replace(/[^A-Za-z0-9._-]/g, "-")}`
}

/** The container's hostname: the workspace id as a DNS label, so a shell prompt names the workspace and a resume keeps it. */
function containerHostname(workspaceId: string) {
  return workspaceId.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "claxedo"
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
      const sandbox = await client.get(sandboxId).catch(hostGoneOrThrow)
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
   * Two commands. `prepare` changes nothing a running container serves from:
   * it waits for the daemon (a resume reboots the VM, and Docker comes up as a
   * systemd service after Boat reports the sandbox ready), logs in, pulls the
   * image, seeds its trees and removes other images' trees; a failure there
   * leaves a runtime of the previous image serving. `start` then replaces
   * another image's container with one of this image, or starts the one of
   * this image Boat itself recreated after a stop that was not this driver's;
   * a create that loses a race with that recreation starts the one that won.
   * A failure there leaves nothing serving.
   */
  function containerScripts(input: SandboxDriverEnsureInput): { prepare: string; start: string } {
    const port = runtimePort(input)
    const directory = workspaceDirectory(input)
    const image = shell(resolveImage(input))
    const trees = `"$(pwd)/${PERSISTENT_ROOT}/${imageTreesDirectory(resolveImage(input))}"`
    const bootScript = [
      `. ${CONTAINER_ENV_PATH}`,
      `mkdir -p ${shell(directory)}`,
      `cd ${shell(directory)}`,
      `exec ${runtimeCommand}`,
    ].join(" && ")
    const mounts = [["workspace", directory], ...PERSISTENT_HOME_MOUNTS]
    // Without an init the runtime is PID 1 and reaps no orphan, so an exited
    // git child stays a zombie and keeps a retired harness's process group alive.
    // Codex sandboxes each command with bubblewrap (--unshare-user, --proc,
    // --dev inside the new namespace); Docker's default seccomp profile refuses
    // unshare to a container without CAP_SYS_ADMIN and its AppArmor profile
    // refuses mount, so under them every Codex command failed to start and fell
    // back to an approval prompt (staging, 2026-10-15). The VM is single-tenant
    // and is the isolation boundary, so the container runs unconfined.
    const run = `docker run -d --name ${containerName} --hostname ${shell(containerHostname(input.workspaceId))} -p ${port}:${port} `
      + `-v ${VM_DOCKER_INIT}:${CONTAINER_INIT_PATH}:ro `
      + `-v "$(pwd)/${RUNTIME_ENV_PATH}:${CONTAINER_ENV_PATH}:ro" `
      + IMAGE_TREES.map((tree) => `-v ${trees}/${tree}:/${tree} `).join("")
      + mounts.map(([source, target]) => `-v "$(pwd)/${PERSISTENT_ROOT}/${source}":${shell(target)} `).join("")
      + `${CONTAINER_SECURITY_OPTIONS} --entrypoint ${CONTAINER_INIT_PATH} ${image} -- sh -lc ${shell(bootScript)}`
    // Streamed out of a created container of the image and unpacked as root so
    // the image's owners and setuid bits survive the copy (the command runs as
    // the VM user). The persistent root is made as root too: Docker made it as
    // root on every sandbox that booted before the trees existed, and the VM
    // user cannot create inside it. A stream that broke leaves no tree and
    // ends the seed before it is marked complete.
    const seed = `if [ ! -f ${trees}/${IMAGE_TREES_COMPLETE_MARKER} ]; then `
      + `sudo rm -rf ${trees} && sudo mkdir -p ${trees} `
      + `&& { docker rm -f ${SEED_CONTAINER_NAME} >/dev/null 2>&1 || true; } `
      + `&& docker create --name ${SEED_CONTAINER_NAME} ${image} true >/dev/null `
      + `&& for tree in ${IMAGE_TREES.join(" ")}; do `
      + `docker cp ${SEED_CONTAINER_NAME}:/$tree - | sudo tar -xf - -C ${trees} ${IMAGE_TREE_SEED_EXCLUDES.map((exclude) => `--exclude=${exclude}`).join(" ")} `
      + `&& [ -d ${trees}/$tree ] || exit 1; done `
      + `&& docker rm ${SEED_CONTAINER_NAME} >/dev/null && sudo touch ${trees}/${IMAGE_TREES_COMPLETE_MARKER}; fi `
      + `&& sudo find "$(pwd)/${PERSISTENT_ROOT}" -mindepth 1 -maxdepth 1 -name 'image-*' ! -path ${trees} -exec rm -rf {} +`
    const ours = `[ "$(docker inspect --format '{{.Config.Image}}' ${containerName} 2>/dev/null)" = ${image} ]`
    const prepare = [
      `chmod 600 ${RUNTIME_ENV_PATH}`,
      `timeout ${DOCKER_DAEMON_WAIT_SECONDS} sh -c 'until docker info >/dev/null 2>&1; do sleep 1; done'`,
      `[ -x ${VM_DOCKER_INIT} ]`,
      ...(options.registryAuth
        ? [`{ chmod 600 ${REGISTRY_PASSWORD_PATH}; docker login ${shell(options.registryAuth.server)} `
          + `--username ${shell(options.registryAuth.username)} --password-stdin < ${REGISTRY_PASSWORD_PATH}; `
          + `rc=$?; rm -f ${REGISTRY_PASSWORD_PATH}; (exit $rc); }`]
        : []),
      `{ docker image inspect ${image} >/dev/null 2>&1 || docker pull ${image} >/dev/null; }`,
      seed,
    ]
    const start = `if ${ours}; then docker start ${containerName} >/dev/null; `
      + `else { docker rm -f ${containerName} >/dev/null 2>&1 || true; } `
      + `&& { ${run} || { ${ours} && docker start ${containerName} >/dev/null; }; }; fi`
    return { prepare: prepare.join(" && "), start }
  }

  async function waitForHealth(sandboxId: string, input: SandboxDriverEnsureInput, secrets: readonly string[]) {
    const port = runtimePort(input)
    const until = Date.now() + healthTimeoutMs
    let last = "workspace runtime not ready"
    while (Date.now() < until) {
      const probe = await client.command(sandboxId, {
        command: `curl -sf -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/global/health || true; echo; `
          + `docker inspect --format '{{.State.Status}}' ${shell(containerName)} 2>/dev/null || echo missing`,
      })
      const [code, state] = probe.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      if (code === "200") return
      last = `health probe returned ${code || "no response"}`
      if (state !== undefined && !BOOTING_CONTAINER_STATES.has(state)) {
        last = `the runtime container is ${state}`
        break
      }
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
    throw new SandboxRuntimeBootError(`Boat ${sandboxId} runtime did not become healthy: ${last}; ${diagnostic}`)
  }

  async function startContainer(sandboxId: string, input: SandboxDriverEnsureInput, hostId: string) {
    const env = { ...bootEnv(input, hostId), ...(await options.env?.(input, { id: hostId })) }
    const scripts = containerScripts(input)
    await client.writeFile(sandboxId, { path: RUNTIME_ENV_PATH, content: envFile(env) })
    if (options.registryAuth) {
      await client.writeFile(sandboxId, { path: REGISTRY_PASSWORD_PATH, content: options.registryAuth.password })
    }
    const secrets = [...workspaceRuntimeBootSecrets(env), ...(options.registryAuth ? [options.registryAuth.password] : [])]
    const failures: unknown[] = []
    try {
      await execOrThrow(sandboxId, scripts.prepare, "runtime image preparation", { timeoutSeconds: IMAGE_PREPARATION_TIMEOUT_SECONDS, secrets })
      try {
        await execOrThrow(sandboxId, scripts.start, "container start", { timeoutSeconds: CONTAINER_START_TIMEOUT_SECONDS, secrets })
      } catch (error) {
        // The container of the previous image is gone by now, so the lease
        // has nothing serving: a boot failure, which the manager demotes,
        // unlike a provider error over a runtime that may still serve.
        throw error instanceof BoatDriverError ? new SandboxRuntimeBootError(error.message) : error
      }
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
      labels: { ...input.labels, ...(resolveImage(input) === options.image ? { [SANDBOX_IMAGE_LABEL]: options.image } : {}) },
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
    const created = await client.create({
      idempotencyKey: `claxedo:${input.workspaceId}:${input.epoch}`,
      ttlSeconds: BOOT_TTL_SECONDS,
      ...(input.machineClass ? { type: input.machineClass } : {}),
    })
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
    // The lease does not say whether its sandbox is archived: one stopped
    // after serving is, one whose boot failed was stopped too, and one a
    // provider error interrupted still runs.
    const state = (await client.get(sandboxId).catch(hostGoneOrThrow)).state
    if (state === "archiving") return { provisioning: true as const, retryAfterMs: provisionIntervalMs }
    // Only a resume can move a sandbox to another size (docs.boat.dev/machines/change-size); a running one keeps its machine.
    if (state === "archived") {
      await client.resume(sandboxId, {
        ttlSeconds: BOOT_TTL_SECONDS,
        ...(input.ensure.machineClass ? { type: input.ensure.machineClass } : {}),
      }).catch(hostGoneOrThrow)
    }
    const ready = await waitUntilReady(sandboxId)
    if (!ready) return { provisioning: true as const, retryAfterMs: provisionIntervalMs }
    return boot(sandboxId, input.ensure, hostId)
  }

  /**
   * The container is ended and removed before Boat archives the sandbox, so
   * the resume creates it once: Boat recreates a container that was running
   * and pulls its image while the start chain pulls the same image for its
   * own create, and the two pulls on one VM took 48–74 s where one takes 31–36 s
   * (staging, 2026-10-13). The runtime gets the grace Boat's own stop gives.
   */
  async function stop(target: SandboxResource) {
    await client.command(target.sandboxId, {
      command: `docker stop -t ${CONTAINER_STOP_GRACE_SECONDS} ${containerName} >/dev/null 2>&1; docker rm -f ${containerName} >/dev/null 2>&1; true`,
      timeoutSeconds: CONTAINER_STOP_GRACE_SECONDS + 30,
    }).catch(hostGoneOrThrow)
    await client.stop(target.sandboxId).catch(hostGoneOrThrow)
  }

  async function destroy(target: SandboxResource) {
    await client.delete(target.sandboxId)
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
  }
}
