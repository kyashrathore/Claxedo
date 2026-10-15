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
import { BoatApiError, createBoatClient, type BoatFetch } from "./boat-client"
import { isTransientDriverError } from "./transient-error"
import { record } from "../json"

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
const HOST_PUBLISH_TIMEOUT_SECONDS = 120
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
// Two boots of one machine can run at once: a start's Durable Object alarm is
// re-run on another machine while the first run still boots (staging,
// 2026-10-15), and a retried epoch resumes the same VM. So a boot stages its
// files under names of its own, and its preparation, container start and port
// publish each hold one lock on the machine, which a second boot waits for and
// then finds the work done. The kernel drops a flock lock with its holder, and
// Boat ends a timed-out command (the next boot took the lock at once; a command
// whose caller went away ran to its end, measured 2026-10-15). /run/lock is a
// tmpfs the VM user writes, so no snapshot carries a lock.
const BOOT_LOCK_PATH = "/run/lock/claxedo-boot.lock"
// A boot's own work after another's is seconds; the rest of its command's limit waits for the other boot.
const BOOT_LOCK_HEADROOM_SECONDS = 60
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
// With every tree mounted, the container needs only the image's top-level
// entries and its config, so it runs from a stub of 67 kB saved beside the
// trees, which a start loads when Docker lacks it (0.3 s), where pulling the
// image takes 47–67 s and fails when ghcr resets the connection (measured
// 2026-10-15). The stub's label names the image it stands for; the container
// inherits it, which tells this driver's container from another.
const STUB_IMAGE = "claxedo-runtime-stub"
const STUB_IMAGE_ARCHIVE = "stub.tar"
const IMAGE_LABEL = "claxedo.image"
// The image's env, one entry per line, for `docker run --env-file`, which
// takes each line as it is; an import's ENV change would expand `$` and quotes.
const IMAGE_ENV_FILE = "image.env"
// The image's top level outside its trees: Debian's merged-/usr links and its
// empty directories (/workspace, the image's only other entry, is mounted).
// It is written on the VM, not read out of a started container of the image:
// Boat recorded a container the seed ran for a second, and a later restore
// recreated it as soon as the image was back, so the next seed could not
// remove the image (2026-10-15).
const ROOT_LINKS = ["bin", "lib", "lib64", "sbin"] as const
const ROOT_DIRECTORIES = ["boot", "dev", "media", "mnt", "proc", "run", "sys", "tmp", ...IMAGE_TREES] as const
// Boat keeps an archive of an image a container used at a snapshot here, named
// by the image's id, and loads it again at every resume (16–19 s for this
// image, measured 2026-10-15); removing the image leaves the archive behind.
const BOAT_SAVED_IMAGES = "/var/lib/ascii-docker-images"
// Boat's record of the containers a restore creates again (a JSON array, one
// entry per container with its create settings, hostname among them). Removing
// a container leaves its entry for at least 20 s, and a deploy from a template
// saved a second after the removal created the builder's container again
// (2026-10-16).
const BOAT_CONTAINER_RECORD = "/etc/ascii-docker.json"
const DOCKER_NAME_IN_USE = "is already in use by container"
const CONTAINER_CREATE_ATTEMPTS = 5
const CONTAINER_SECURITY_OPTIONS = "--security-opt seccomp=unconfined --security-opt apparmor=unconfined"
// `--init` mounts Docker's init at /sbin/docker-init, which the image's merged
// /usr resolves into the bind-mounted /usr, where it does not exist; the VM's
// binary is mounted at a path of its own instead.
const VM_DOCKER_INIT = "/usr/libexec/docker/docker-init"
const CONTAINER_INIT_PATH = "/claxedo-init"
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

/**
 * Turns a booted machine into one any workspace can start from: it keeps what
 * every machine of the image shares (the image's trees, stub archive and env,
 * and Boat's ~/.ascii/playbook.json) and removes what this machine's boot made
 * (the runtime container and Boat's record and image archive of it, the
 * workspace, the runtime's state, the boot's env). Nothing the runtime wrote
 * into the image's trees was found there (Boat, 2026-10-16: the trees held only
 * the image's own entries after two boots); what else differs on the machine
 * is Boat's own, and a machine created from the template gets its own
 * machine-id, SSH host keys, hostname and no hosted port.
 */
export function boatTemplateResetCommand() {
  const bootFiles = [
    `${PERSISTENT_ROOT}/workspace`,
    ...PERSISTENT_HOME_MOUNTS.map(([source]) => `${PERSISTENT_ROOT}/${source}`),
    RUNTIME_ENV_PATH,
    `${RUNTIME_ENV_PATH}.*`,
    `${REGISTRY_PASSWORD_PATH}.*`,
  ]
  return `{ docker rm -f ${DEFAULT_CONTAINER_NAME} >/dev/null 2>&1 || true; } && sudo rm -rf ${bootFiles.join(" ")} `
    + `&& [ -z "$(docker ps -aq)" ] && echo '[]' | sudo tee ${BOAT_CONTAINER_RECORD} >/dev/null && sudo find ${BOAT_SAVED_IMAGES} -mindepth 1 -delete `
    + `&& ls -d ${PERSISTENT_ROOT}/image-*/${IMAGE_TREES_COMPLETE_MARKER}`
}

function hostGoneOrThrow(err: unknown): never {
  if (err instanceof BoatApiError && GONE_CODES.has(err.code)) throw new SandboxHostGoneError(err.message)
  throw err
}

function stoppedOrThrow(err: unknown): void {
  if (err instanceof BoatApiError && NOT_RUNNING_CODES.has(err.code)) return
  hostGoneOrThrow(err)
}

type StagedFiles = { env: string; password?: string }

function holdingBootLock(commandTimeoutSeconds: number, script: string) {
  const wait = commandTimeoutSeconds - BOOT_LOCK_HEADROOM_SECONDS
  return `exec 9>>${BOOT_LOCK_PATH} && { flock -w ${wait} 9 || { echo "another boot of this machine held ${BOOT_LOCK_PATH} for ${wait} s" >&2; exit 1; }; } && ${script}`
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
   * systemd service after Boat reports the sandbox ready), logs in, and, when
   * the image's trees, stub or env are missing, pulls it and seeds what is
   * missing; it loads the stub when Docker does not hold this image's, and
   * removes other images' trees. A failure there leaves a runtime of the
   * previous image serving. `start` then replaces another image's container
   * with one of this image, or starts this image's container that is already
   * there: the one the stop kept, which Boat's restore creates again stopped,
   * or one Boat recreated after a stop that was not this driver's; then it
   * removes the image if a seed left it. A failure there leaves nothing
   * serving.
   */
  function containerScripts(input: SandboxDriverEnsureInput, staged: StagedFiles): { prepare: string; start: string } {
    const port = runtimePort(input)
    const directory = workspaceDirectory(input)
    const reference = resolveImage(input)
    const image = shell(reference)
    const trees = `"$(pwd)/${PERSISTENT_ROOT}/${imageTreesDirectory(reference)}"`
    const labelledWithImage = (object: "image" | "container", name: string) =>
      `[ "$(docker ${object} inspect --format '{{index .Config.Labels "${IMAGE_LABEL}"}}' ${name} 2>/dev/null)" = ${image} ]`
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
      + `--env-file ${trees}/${IMAGE_ENV_FILE} `
      + IMAGE_TREES.map((tree) => `-v ${trees}/${tree}:/${tree} `).join("")
      + mounts.map(([source, target]) => `-v "$(pwd)/${PERSISTENT_ROOT}/${source}":${shell(target)} `).join("")
      + `${CONTAINER_SECURITY_OPTIONS} --entrypoint ${CONTAINER_INIT_PATH} ${STUB_IMAGE} -- sh -lc ${shell(bootScript)}`
    // Streamed out of a created container of the image and unpacked as root so
    // the image's owners and setuid bits survive the copy (the command runs as
    // the VM user). The persistent root is made as root too: Docker made it as
    // root on every sandbox that booted before the trees existed, and the VM
    // user cannot create inside it. A stream that broke leaves no tree and
    // ends the seed before it is marked complete.
    const seedTrees = `sudo rm -rf ${trees} && sudo mkdir -p ${trees} `
      + `&& { docker rm -f ${SEED_CONTAINER_NAME} >/dev/null 2>&1 || true; } `
      + `&& docker create --name ${SEED_CONTAINER_NAME} ${image} true >/dev/null `
      + `&& for tree in ${IMAGE_TREES.join(" ")}; do `
      + `docker cp ${SEED_CONTAINER_NAME}:/$tree - | sudo tar -xf - -C ${trees} ${IMAGE_TREE_SEED_EXCLUDES.map((exclude) => `--exclude=${exclude}`).join(" ")} `
      + `&& [ -d ${trees}/$tree ] || exit 1; done `
      + `&& docker rm ${SEED_CONTAINER_NAME} >/dev/null && sudo touch ${trees}/${IMAGE_TREES_COMPLETE_MARKER}`
    const seedStub = `stub=$(mktemp -d) `
      + `&& docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' ${image} > "$stub/${IMAGE_ENV_FILE}" `
      + `&& workdir=$(docker image inspect --format '{{or .Config.WorkingDir "/"}}' ${image}) `
      + `&& mkdir "$stub/root" ${ROOT_DIRECTORIES.map((directory) => `"$stub/root/${directory}"`).join(" ")} `
      + `&& ${ROOT_LINKS.map((link) => `ln -s usr/${link} "$stub/root/${link}"`).join(" && ")} && chmod 1777 "$stub/root/tmp" `
      + `&& tar --owner=0 --group=0 --numeric-owner -cf "$stub/skeleton.tar" -C "$stub/root" . `
      + `&& docker import --change "WORKDIR $workdir" --change ${shell(`LABEL ${IMAGE_LABEL}=${reference}`)} "$stub/skeleton.tar" ${STUB_IMAGE} >/dev/null `
      + `&& docker save -o "$stub/${STUB_IMAGE_ARCHIVE}" ${STUB_IMAGE} `
      + `&& sudo mv "$stub/${IMAGE_ENV_FILE}" "$stub/${STUB_IMAGE_ARCHIVE}" ${trees}/ && rm -rf "$stub"`
    // Run by the start once the runtime container is this image's stub's: until
    // then it may be one of the image itself (an earlier driver ran the image),
    // and any other container of the image is a leftover, such as a seed
    // container Boat created again.
    const removeImage = `if docker image inspect ${image} >/dev/null 2>&1; then `
      + `leftovers=$(docker ps -aq --filter ancestor=${image}) && { [ -z "$leftovers" ] || docker rm -f $leftovers >/dev/null; } `
      + `&& id=$(docker image inspect --format '{{.Id}}' ${image}) && docker rmi ${image} >/dev/null `
      + `&& sudo rm -f ${BOAT_SAVED_IMAGES}/"\${id#sha256:}".tar; fi`
    const seeded = [IMAGE_TREES_COMPLETE_MARKER, STUB_IMAGE_ARCHIVE, IMAGE_ENV_FILE].map((file) => `[ -f ${trees}/${file} ]`).join(" && ")
    const prepare = [
      `chmod 600 ${staged.env}`,
      `find . -maxdepth 1 \\( -name '${RUNTIME_ENV_PATH}.*' -o -name '${REGISTRY_PASSWORD_PATH}.*' \\) -mmin +${BOOT_TTL_SECONDS / 60} -exec rm -f {} +`,
      `timeout ${DOCKER_DAEMON_WAIT_SECONDS} sh -c 'until docker info >/dev/null 2>&1; do sleep 1; done'`,
      `[ -x ${VM_DOCKER_INIT} ]`,
      ...(options.registryAuth && staged.password
        ? [`{ chmod 600 ${staged.password}; docker login ${shell(options.registryAuth.server)} `
          + `--username ${shell(options.registryAuth.username)} --password-stdin < ${staged.password}; `
          + `rc=$?; rm -f ${staged.password}; (exit $rc); }`]
        : []),
      // Trees an earlier start marked complete hold what a person or a harness
      // changed since, so a seed missing only its stub or env builds those alone.
      `if ! { ${seeded}; }; then { docker image inspect ${image} >/dev/null 2>&1 || docker pull ${image} >/dev/null; } `
        + `&& { [ -f ${trees}/${IMAGE_TREES_COMPLETE_MARKER} ] || { ${seedTrees}; }; } && ${seedStub}; fi`,
      `{ ${labelledWithImage("image", STUB_IMAGE)} || docker load -i ${trees}/${STUB_IMAGE_ARCHIVE} >/dev/null; }`,
      `sudo find "$(pwd)/${PERSISTENT_ROOT}" -mindepth 1 -maxdepth 1 -name 'image-*' ! -path ${trees} -exec rm -rf {} +`,
    ]
    // Boat's restore creates the containers its snapshot recorded 2 s after
    // Docker answers, and creates them again after a removal (2026-10-15), so
    // a start that looked before it finds the name taken by the container the
    // stop kept. Docker holds the name from the start of that create, so each
    // retry waits out the 0.8 s it takes, then starts the container when it is
    // this image's and replaces it when it is another's.
    const start = `mv -f ${staged.env} ${RUNTIME_ENV_PATH} && up=; for attempt in $(seq ${CONTAINER_CREATE_ATTEMPTS}); do [ "$attempt" = 1 ] || sleep 1; `
      + `if ${labelledWithImage("container", containerName)}; then failure=$(docker start ${containerName} 2>&1 >/dev/null) && { up=1; break; }; `
      + `else docker rm -f ${containerName} >/dev/null 2>&1; failure=$(${run} 2>&1 >/dev/null) && { up=1; break; }; fi; `
      + `case "$failure" in *${shell(DOCKER_NAME_IN_USE)}*) ;; *) break ;; esac; done; `
      + `[ -n "$up" ] || { echo "$failure" >&2; false; } && ${removeImage}`
    return {
      prepare: holdingBootLock(IMAGE_PREPARATION_TIMEOUT_SECONDS, prepare.join(" && ")),
      start: holdingBootLock(CONTAINER_START_TIMEOUT_SECONDS, start),
    }
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
      diagnostic = runtimeBootDiagnostic(scrubbed(`${result.stdout}\n${result.stderr}`, secrets), STDERR_TAIL_CHARS)
    } catch {
      diagnostic = "container diagnostics unavailable"
    }
    throw new SandboxRuntimeBootError(`Boat ${sandboxId} runtime did not become healthy: ${last}; ${diagnostic}`)
  }

  async function startContainer(sandboxId: string, input: SandboxDriverEnsureInput, hostId: string) {
    const env = { ...bootEnv(input, hostId), ...(await options.env?.(input, { id: hostId })) }
    const boot = crypto.randomUUID()
    const staged: StagedFiles = {
      env: `${RUNTIME_ENV_PATH}.${boot}`,
      ...(options.registryAuth ? { password: `${REGISTRY_PASSWORD_PATH}.${boot}` } : {}),
    }
    const scripts = containerScripts(input, staged)
    await client.writeFile(sandboxId, { path: staged.env, content: envFile(env) })
    if (options.registryAuth && staged.password) {
      await client.writeFile(sandboxId, { path: staged.password, content: options.registryAuth.password })
    }
    const secrets = [...workspaceRuntimeBootSecrets(env), ...(options.registryAuth ? [options.registryAuth.password] : [])]
    let failure: unknown
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
      failure = error
    }
    // The login step removes the staged password and the start moves the
    // staged env into place when they run; this covers failures before then.
    // A cleanup that fails after the boot did is told in the boot's own error,
    // which keeps its kind and is the text the lease records.
    try {
      if (options.registryAuth || failure !== undefined) {
        await execOrThrow(sandboxId, `rm -f ${[staged.env, staged.password].filter(Boolean).join(" ")}`, "staged file cleanup", { secrets })
      }
    } catch (cleanupFailure) {
      if (failure === undefined) throw cleanupFailure
      if (failure instanceof Error) failure.message = `${failure.message}; ${cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure)}`
    }
    if (failure !== undefined) throw failure
    return secrets
  }

  async function boot(sandboxId: string, input: SandboxDriverEnsureInput, hostId: string): Promise<SandboxTarget> {
    await input.onMachineReady?.()
    const port = runtimePort(input)
    const secrets = await startContainer(sandboxId, input, hostId)
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
      labels: { ...input.labels, ...(resolveImage(input) === options.image ? { [SANDBOX_IMAGE_LABEL]: options.image } : {}) },
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
      }).catch((err: unknown) => {
        // Another boot of this workspace resumed it first; its resume brings the sandbox up for both.
        if (err instanceof BoatApiError && err.code === RESUME_UNDER_WAY) return
        hostGoneOrThrow(err)
      })
    }
    const ready = await waitUntilReady(sandboxId)
    if (!ready) return { provisioning: true as const, retryAfterMs: provisionIntervalMs }
    return boot(sandboxId, input.ensure, hostId)
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
    }).then(() => undefined, stoppedOrThrow)
    await client.stop(target.sandboxId).catch(stoppedOrThrow)
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
