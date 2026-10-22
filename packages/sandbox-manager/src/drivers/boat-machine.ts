import { shell } from "../command"
import { MINIMUM_SERVED_WORKSPACE_RUNTIME_VERSION } from "../runtime-version"

// What a Boat machine runs to boot the workspace runtime: the image's trees
// seeded onto the VM's disk, the runtime's container started from a stub over
// them, and the reset that turns a booted machine into a template.

// An image pull and the seed need Boat's documented command maximum.
export const IMAGE_PREPARATION_TIMEOUT_SECONDS = 600
// The image is local by then; creating the container is seconds.
export const CONTAINER_START_TIMEOUT_SECONDS = 120

export const DEFAULT_CONTAINER_NAME = "claxedo-runtime"
const DOCKER_DAEMON_WAIT_SECONDS = 120
// Written via PUT /sandboxes/{id}/files — the provider's file channel — so env
// and registry credentials never appear in a /commands body, which Boat
// executes and can log. Paths are relative to the sandbox work directory,
// where commands also start; the container reads the env through a read-only
// bind mount.
export const RUNTIME_ENV_PATH = ".claxedo-runtime-env"
export const REGISTRY_PASSWORD_PATH = ".claxedo-registry-password"
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

export type StagedFiles = { env: string; password?: string }

export function holdingBootLock(commandTimeoutSeconds: number, script: string) {
  const wait = commandTimeoutSeconds - BOOT_LOCK_HEADROOM_SECONDS
  return `exec 9>>${BOOT_LOCK_PATH} && { flock -w ${wait} 9 || { echo "another boot of this machine held ${BOOT_LOCK_PATH} for ${wait} s" >&2; exit 1; }; } && ${script}`
}

/** The container's hostname: the workspace id as a DNS label, so a shell prompt names the workspace and a resume keeps it. */
function containerHostname(workspaceId: string) {
  return workspaceId.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "claxedo"
}

/**
 * The image a boot names and the one it may keep serving instead. A resume of
 * a machine whose trees hold only an older image keeps that image when its
 * runtime is no older than the oldest the control plane serves, so a wake
 * after a deploy does not wait 60–100 s on the new image's pull and seed
 * (staging, 2026-10-21); the workspace then reads as outdated, and the
 * person's Restart to update asks for the new image with `keepPreviousImage`
 * off. A cold boot has no previous image to keep.
 */
export type MachineBoot = {
  image: string
  keepPreviousImage: boolean
  workspaceId: string
  directory: string
  port: number
  runtimeCommand: string
  containerName: string
  registry?: { server: string; username: string }
  staged: StagedFiles
  staleStagedMinutes: number
}

/** Where a boot's preparation leaves the image it booted for its container start to read. */
export function bootedImageFile(staged: StagedFiles) {
  return `${staged.env}.image`
}

/** The image a preparation booted: the last line it prints, since `docker login` prints before it. */
export function bootedImage(prepareStdout: string) {
  return prepareStdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop()
}

const VERSION_FILE = "opt/workspace-runtime/workspace-runtime-version"

const stubLabel = `docker image inspect --format '{{index .Config.Labels "${IMAGE_LABEL}"}}' ${STUB_IMAGE} 2>/dev/null`

// Shell functions every boot command defines: the trees directory an image
// reference maps to (one per image), whether an image's trees, stub and env
// are all there, and whether the runtime in an image's trees is one the
// control plane still serves.
const treesFunctions = [
  `trees_of() { printf '%s/${PERSISTENT_ROOT}/image-%s' "$(pwd)" "$(printf %s "$1" | sed 's/[^A-Za-z0-9._-]/-/g')"; }`,
  `seeded() { [ -f "$1/${IMAGE_TREES_COMPLETE_MARKER}" ] && [ -f "$1/${STUB_IMAGE_ARCHIVE}" ] && [ -f "$1/${IMAGE_ENV_FILE}" ]; }`,
  `served() { version=$(cat "$1/${VERSION_FILE}" 2>/dev/null) && [ -n "$version" ] && [ "$(printf '%s\\n%s\\n' ${MINIMUM_SERVED_WORKSPACE_RUNTIME_VERSION} "$version" | sort -V | head -n 1)" = ${MINIMUM_SERVED_WORKSPACE_RUNTIME_VERSION} ]; }`,
].join(" && ")

/**
 * The command carries only paths: env arrives through the staged file
 * (mounted read-only, sourced by the entrypoint at every container start so
 * multi-line values like PEMs survive — `docker run --env-file` cannot
 * express them), and the registry password is piped to `docker login` from a
 * file that is removed whatever the outcome; a failed login aborts the chain.
 *
 * Two commands. `prepare` changes nothing a running container serves from:
 * it waits for the daemon (a resume reboots the VM, and Docker comes up as a
 * systemd service after Boat reports the sandbox ready), logs in, and settles
 * which image boots: the one named when its trees, stub and env are there;
 * the one the machine last booted when the boot may keep it and its trees
 * hold a runtime still served; otherwise the one named, pulled and seeded
 * where anything is missing. It loads that image's stub when Docker does not
 * hold it, removes every other image's trees, writes the image for `start`
 * and prints it. A failure there leaves a runtime of the previous image
 * serving. `start` then replaces another image's container with one of the
 * booted image, or starts that image's container that is already there: the
 * one the stop kept, which Boat's restore creates again stopped, or one Boat
 * recreated after a stop that was not this driver's; then it removes the
 * image if a seed left it. A failure there leaves nothing serving.
 */
export function machineBootScripts(boot: MachineBoot): { prepare: string; start: string } {
  const named = shell(boot.image)
  const trees = `"$(trees_of ${named})"`
  const bootedFile = bootedImageFile(boot.staged)
  const containerOfBooted = `[ "$(docker container inspect --format '{{index .Config.Labels "${IMAGE_LABEL}"}}' ${boot.containerName} 2>/dev/null)" = "$booted" ]`
  const bootScript = [
    `. ${CONTAINER_ENV_PATH}`,
    `mkdir -p ${shell(boot.directory)}`,
    `cd ${shell(boot.directory)}`,
    `exec ${boot.runtimeCommand}`,
  ].join(" && ")
  const mounts = [["workspace", boot.directory], ...PERSISTENT_HOME_MOUNTS]
  // Without an init the runtime is PID 1 and reaps no orphan, so an exited
  // git child stays a zombie and keeps a retired harness's process group alive.
  // Codex sandboxes each command with bubblewrap (--unshare-user, --proc,
  // --dev inside the new namespace); Docker's default seccomp profile refuses
  // unshare to a container without CAP_SYS_ADMIN and its AppArmor profile
  // refuses mount, so under them every Codex command failed to start and fell
  // back to an approval prompt (staging, 2026-10-15). The VM is single-tenant
  // and is the isolation boundary, so the container runs unconfined.
  const run = `docker run -d --name ${boot.containerName} --hostname ${shell(containerHostname(boot.workspaceId))} -p ${boot.port}:${boot.port} `
    + `-v ${VM_DOCKER_INIT}:${CONTAINER_INIT_PATH}:ro `
    + `-v "$(pwd)/${RUNTIME_ENV_PATH}:${CONTAINER_ENV_PATH}:ro" `
    + `--env-file "$trees/${IMAGE_ENV_FILE}" `
    + IMAGE_TREES.map((tree) => `-v "$trees/${tree}":/${tree} `).join("")
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
    + `&& docker create --name ${SEED_CONTAINER_NAME} ${named} true >/dev/null `
    + `&& for tree in ${IMAGE_TREES.join(" ")}; do `
    + `docker cp ${SEED_CONTAINER_NAME}:/$tree - | sudo tar -xf - -C ${trees} ${IMAGE_TREE_SEED_EXCLUDES.map((exclude) => `--exclude=${exclude}`).join(" ")} `
    + `&& [ -d ${trees}/$tree ] || exit 1; done `
    + `&& docker rm ${SEED_CONTAINER_NAME} >/dev/null && sudo touch ${trees}/${IMAGE_TREES_COMPLETE_MARKER}`
  const seedStub = `stub=$(mktemp -d) `
    + `&& docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' ${named} > "$stub/${IMAGE_ENV_FILE}" `
    + `&& workdir=$(docker image inspect --format '{{or .Config.WorkingDir "/"}}' ${named}) `
    + `&& mkdir "$stub/root" ${ROOT_DIRECTORIES.map((directory) => `"$stub/root/${directory}"`).join(" ")} `
    + `&& ${ROOT_LINKS.map((link) => `ln -s usr/${link} "$stub/root/${link}"`).join(" && ")} && chmod 1777 "$stub/root/tmp" `
    + `&& tar --owner=0 --group=0 --numeric-owner -cf "$stub/skeleton.tar" -C "$stub/root" . `
    + `&& docker import --change "WORKDIR $workdir" --change ${shell(`LABEL ${IMAGE_LABEL}=${boot.image}`)} "$stub/skeleton.tar" ${STUB_IMAGE} >/dev/null `
    + `&& docker save -o "$stub/${STUB_IMAGE_ARCHIVE}" ${STUB_IMAGE} `
    + `&& sudo mv "$stub/${IMAGE_ENV_FILE}" "$stub/${STUB_IMAGE_ARCHIVE}" ${trees}/ && rm -rf "$stub"`
  // Trees an earlier start marked complete hold what a person or a harness
  // changed since, so a seed missing only its stub or env builds those alone.
  const seedNamed = `{ docker image inspect ${named} >/dev/null 2>&1 || docker pull ${named} >/dev/null; } `
    + `&& { [ -f ${trees}/${IMAGE_TREES_COMPLETE_MARKER} ] || { ${seedTrees}; }; } && ${seedStub}`
  // The machine's last boot is the image its stub, which Boat's resume loads again, stands for.
  const keepPrevious = `previous=$(${stubLabel}) && [ -n "$previous" ] && seeded "$(trees_of "$previous")" && served "$(trees_of "$previous")"`
  // Run by the start once the runtime container is the booted image's stub's:
  // until then it may be one of the image itself (an earlier driver ran the
  // image), and any other container of the image is a leftover, such as a seed
  // container Boat created again.
  const removeImage = `if docker image inspect "$booted" >/dev/null 2>&1; then `
    + `leftovers=$(docker ps -aq --filter ancestor="$booted") && { [ -z "$leftovers" ] || docker rm -f $leftovers >/dev/null; } `
    + `&& id=$(docker image inspect --format '{{.Id}}' "$booted") && docker rmi "$booted" >/dev/null `
    + `&& sudo rm -f ${BOAT_SAVED_IMAGES}/"\${id#sha256:}".tar; fi`
  const prepare = [
    `chmod 600 ${boot.staged.env}`,
    `find . -maxdepth 1 \\( -name '${RUNTIME_ENV_PATH}.*' -o -name '${REGISTRY_PASSWORD_PATH}.*' \\) -mmin +${boot.staleStagedMinutes} -exec rm -f {} +`,
    `timeout ${DOCKER_DAEMON_WAIT_SECONDS} sh -c 'until docker info >/dev/null 2>&1; do sleep 1; done'`,
    `[ -x ${VM_DOCKER_INIT} ]`,
    ...(boot.registry && boot.staged.password
      ? [`{ chmod 600 ${boot.staged.password}; docker login ${shell(boot.registry.server)} `
        + `--username ${shell(boot.registry.username)} --password-stdin < ${boot.staged.password}; `
        + `rc=$?; rm -f ${boot.staged.password}; (exit $rc); }`]
      : []),
    treesFunctions,
    `booted=${named}`,
    `if ! seeded ${trees}; then `
      + (boot.keepPreviousImage ? `if ${keepPrevious}; then booted=$previous; else ${seedNamed}; fi` : seedNamed)
      + `; fi`,
    `{ [ "$(${stubLabel})" = "$booted" ] || docker load -i "$(trees_of "$booted")/${STUB_IMAGE_ARCHIVE}" >/dev/null; }`,
    `sudo find "$(pwd)/${PERSISTENT_ROOT}" -mindepth 1 -maxdepth 1 -name 'image-*' ! -path "$(trees_of "$booted")" -exec rm -rf {} +`,
    `printf '%s\\n' "$booted" > ${bootedFile}`,
    `printf '%s\\n' "$booted"`,
  ]
  // Boat's restore creates the containers its snapshot recorded 2 s after
  // Docker answers, and creates them again after a removal (2026-10-15), so
  // a start that looked before it finds the name taken by the container the
  // stop kept. Docker holds the name from the start of that create, so each
  // retry waits out the 0.8 s it takes, then starts the container when it is
  // the booted image's and replaces it when it is another's.
  const start = `${treesFunctions} && booted=$(cat ${bootedFile}) && trees=$(trees_of "$booted") && rm -f ${bootedFile} `
    + `&& mv -f ${boot.staged.env} ${RUNTIME_ENV_PATH} && up=; for attempt in $(seq ${CONTAINER_CREATE_ATTEMPTS}); do [ "$attempt" = 1 ] || sleep 1; `
    + `if ${containerOfBooted}; then failure=$(docker start ${boot.containerName} 2>&1 >/dev/null) && { up=1; break; }; `
    + `else docker rm -f ${boot.containerName} >/dev/null 2>&1; failure=$(${run} 2>&1 >/dev/null) && { up=1; break; }; fi; `
    + `case "$failure" in *${shell(DOCKER_NAME_IN_USE)}*) ;; *) break ;; esac; done; `
    + `[ -n "$up" ] || { echo "$failure" >&2; false; } && ${removeImage}`
  return {
    prepare: holdingBootLock(IMAGE_PREPARATION_TIMEOUT_SECONDS, prepare.join(" && ")),
    start: holdingBootLock(CONTAINER_START_TIMEOUT_SECONDS, start),
  }
}
