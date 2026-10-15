import { spawn, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { createBoatSandboxDriver, type BoatFetch } from "./boat"
import { createSandboxManager, isSandboxHostGone, isSandboxProviderKeyRefused, isSandboxRuntimeBootFailure, sandboxRuntimeBootFailure, type SandboxDriverEnsureInput } from ".."
import { createMemoryLeaseStore, sandboxLease } from "../stores/memory"

type Call = { path: string; method: string; headers: Record<string, string>; body?: any }

const ID = "bx_23456789"
const API = "https://boat.dev/api/v1"
const IMAGE = "ghcr.io/test/sandbox:1"

function ensureInput(overrides?: Partial<SandboxDriverEnsureInput>): SandboxDriverEnsureInput {
  return {
    workspaceId: "ws1",
    homeRegion: "eu",
    epoch: 1,
    labels: { app: "claxedo", workspaceId: "ws1", epoch: "1" },
    bootSource: { kind: "default" },
    workspaceRoot: "/workspace",
    workspaceRuntimePort: 2593,
    env: {},
    ...overrides,
  }
}

function sandboxRecord(state: string) {
  return {
    id: ID, name: "Sandbox 2026-10-03 12:00", state, url: "https://machine.on.boat.dev", ip: "203.0.113.10",
    createdAt: "2026-10-03T12:00:00Z", updatedAt: "2026-10-03T12:05:00Z", archiveAfter: null,
    desktopAvailable: true, snapshotAvailable: false, snapshotCompletedAt: null,
  }
}

function commandFinished(input: { stdout?: string; stderr?: string; exitCode?: number | null; timedOut?: boolean }) {
  const exitCode = input.exitCode === undefined ? 0 : input.exitCode
  return {
    type: "command.finished", success: exitCode === 0 && !input.timedOut, exitCode, stdout: input.stdout ?? "", stderr: input.stderr ?? "",
    timedOut: input.timedOut ?? false, signal: null, oomKilled: false, stdoutTruncated: false, stderrTruncated: false,
    cwd: "/home/user", startedAt: "2026-10-03T12:06:00Z", finishedAt: "2026-10-03T12:06:01Z",
  }
}

/**
 * The Boat v1 API as it answers, which docs.boat.dev/api/v1 follows except
 * that the TTL update answers `sandbox.updated`: sandbox
 * creation → readiness polling → command execution (docker run / host /
 * health probe / host url), a stop that archives the sandbox until it is
 * resumed, and the TTL update. Records every call so tests can assert on it;
 * `options` is read at each call, so a test changes the sandbox mid-flight.
 */
function fakeBoat(options: { states?: string[]; hostUrl?: string; failHealthOnce?: boolean; failingStderr?: string; containerState?: string; hostPublishFailures?: string[] } = {}) {
  const calls: Call[] = []
  const states = options.states ?? ["ready"]
  let stateIdx = 0
  let healthChecks = 0
  let archived = false
  const hostUrl = options.hostUrl ?? "https://machine-2593.on.boat.dev"

  const fetchImpl: BoatFetch = async (input, init) => {
    const path = input.replace(API, "")
    const method = init?.method ?? "GET"
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    calls.push({ path, method, headers: { ...init?.headers as Record<string, string> }, body })
    const json = (obj: object, status = 200) => Response.json({ ok: true, ...obj }, { status })

    if (path === "/sandboxes" && method === "POST") {
      return json({ type: "sandbox.created", status: "provisioning", ttlSeconds: body.ttlSeconds, sandbox: sandboxRecord("provisioning") }, 202)
    }
    if (path === `/sandboxes/${ID}` && method === "GET") {
      if (archived) return json({ type: "sandbox.info", sandbox: sandboxRecord("archived") })
      const state = states[Math.min(stateIdx, states.length - 1)]
      stateIdx++
      return json({ type: "sandbox.info", sandbox: sandboxRecord(state) })
    }
    if (path === `/sandboxes/${ID}` && method === "PATCH") {
      return json({ type: "sandbox.updated", sandbox: { ...sandboxRecord("ready"), archiveAfter: body.ttlSeconds === null ? null : "2026-10-03T12:30:00Z" } })
    }
    if (path === `/sandboxes/${ID}/files` && method === "PUT") {
      return json({ type: "file.written", success: true, path: `/home/user/${body.path}`, encoding: "utf8", size: body.content.length })
    }
    if (path === `/sandboxes/${ID}/commands` && method === "POST") {
      const command: string = body.command
      if (options.failingStderr) return json(commandFinished({ stderr: options.failingStderr, exitCode: 125 }))
      if (command.includes("/global/health")) {
        healthChecks++
        const healthy = options.failHealthOnce ? healthChecks > 1 : true
        return json(commandFinished({ stdout: `${healthy ? "200" : "000"}\n${options.containerState ?? "running"}` }))
      }
      if (command.startsWith("host url")) return json(commandFinished({ stdout: `${hostUrl}\n` }))
      const publishFailure = isHostCommand(command) ? options.hostPublishFailures?.shift() : undefined
      if (publishFailure) return json(commandFinished({ stderr: publishFailure, exitCode: 1 }))
      return json(commandFinished({}))
    }
    if (path === `/sandboxes/${ID}/stop` && method === "POST") {
      archived = true
      return json({ type: "sandbox.stopping", id: ID, status: "archiving", sandbox: sandboxRecord("archiving") }, 202)
    }
    if (path === `/sandboxes/${ID}/resume` && method === "POST") {
      archived = false
      return json({ type: "sandbox.resuming", id: ID, status: "provisioning", sandbox: sandboxRecord("provisioning") }, 202)
    }
    if (path === `/sandboxes/${ID}` && method === "DELETE") {
      return json({ type: "sandbox.deleting", operation: { id: "op_1", kind: "sandbox", targetId: ID, status: "queued" } }, 202)
    }
    return Response.json({ ok: false, code: "not_found", message: `unhandled ${method} ${path}` }, { status: 404 })
  }
  return { fetchImpl, calls, options, get healthChecks() { return healthChecks } }
}

const BOOT_TTL_SECONDS = 30 * 60

/** Boat's in-sandbox `host`, sent bare or behind the machine's boot lock. */
const isHostCommand = (command: string) => /(^|&& )host /.test(command)

const ttlUpdates = (calls: Call[]) => calls.filter((c) => c.path === `/sandboxes/${ID}` && c.method === "PATCH").map((c) => c.body)

const IMAGE_TREES = ["root", "usr", "etc", "var", "opt", "home", "srv"]
const treesDirectory = (image: string) => `image-${image.replace(/[^A-Za-z0-9._-]/g, "-")}`

const STUB_IMAGE = "claxedo-runtime-stub"
const IMAGE_ID = "sha256:5eed1d"

/**
 * Runs the driver's container start commands under a real `sh`, with `docker`,
 * `timeout` and `sudo` replaced by a recorder over one container slot and two
 * image slots: the image (present once pulled, until removed) and the stub
 * (holding the image reference its label names). `docker info` fails until the
 * daemon has been asked `daemonUpAfter` times, `cp` streams a tree of the
 * image's rootfs stand-in (one marker file per tree), `import` (keeping the
 * root it was given) and `load` fill the stub slot, a container takes the
 * stub's label, and `run -d` conflicts while the slot is taken. Boat's own
 * recreation fills the slot just before the next `recreatedBeforeRun` creates.
 * `seededImages` are the images whose trees an earlier start left complete;
 * `boatSavedImages` are the image archives Boat keeps under its own directory.
 */
// The start command is the sh script Boat runs on its Linux VM. A start spawns dozens of real shells, and with the
// machine at a load average of 11 the five-create case took 6.8 s, past the test runner's 5 s default.
const VM_TEST_TIMEOUT_MS = 30_000
const onVm = (name: string, run: () => Promise<void>) => test.skipIf(process.platform === "win32")(name, run, VM_TEST_TIMEOUT_MS)

type StartCommands = { prepare: string; start: string; staged: string[] }

type Vm = {
  existingImage?: string
  daemonUpAfter?: number
  /** Images whose containers Boat creates again under the runtime's name, one before each create. */
  recreatedBeforeRun?: string[]
  /** Boat removes the container it created again as soon as the create it raced has failed. */
  recreatedVanishes?: boolean
  /** A create that fails without leaving a container behind. */
  runFails?: boolean
  seededImages?: string[]
  /** Images whose trees an earlier driver seeded and marked complete, with no stub or env beside them. */
  seededWithoutStub?: string[]
  /** The container in the slot runs from the image itself, as an earlier driver's runtime did. */
  existingUsesImage?: boolean
  /** Ids of containers of the image other than the runtime, such as a seed container Boat created again. */
  imageContainers?: string[]
  imagePulled?: boolean
  /** The image reference the label of the stub Docker holds names. */
  stubLoaded?: string
  boatSavedImages?: string[]
  /** The persistent root exists and the VM user cannot write into it, as Docker left it on every sandbox that booted before the trees existed. */
  persistentRootReadOnly?: boolean
  /** The image's trees cannot be streamed out. */
  seedFails?: boolean
  /** Another boot of the machine holds the boot lock past this boot's wait. */
  bootLockHeld?: boolean
  /** Files a boot that never finished staged, written long before this boot. */
  staleStaged?: string[]
  /** Run in the fixture an earlier run left, as a later start on the same VM. */
  dir?: string
}

function vmFixture(vm: Vm) {
  const dir = vm.dir ?? mkdtempSync(path.join(tmpdir(), "boat-start-"))
  const bin = path.join(dir, "bin")
  const log = path.join(dir, "docker.log")
  const slot = path.join(dir, "container")
  const images = path.join(dir, "images")
  const rootfs = path.join(dir, "rootfs")
  const boatImages = path.join(dir, "ascii-docker-images")
  const recreations = path.join(dir, "recreations")
  const imageContainers = path.join(dir, "image-containers")
  const slotUsesImage = path.join(dir, "container-uses-image")
  const seedSlot = path.join(dir, "seed-container")
  const bootLock = path.join(dir, "boot.lock")
  const persistentRoot = path.join(dir, "claxedo-persistent")
  writeFileSync(log, "")
  if (!vm.dir) {
    mkdirSync(bin)
    mkdirSync(images)
    mkdirSync(path.join(dir, "tmp"))
    mkdirSync(boatImages)
    writeFileSync(path.join(dir, "docker-init"), "")
    for (const file of vm.staleStaged ?? []) {
      writeFileSync(path.join(dir, file), "secret")
      utimesSync(path.join(dir, file), new Date(Date.now() - 31 * 60_000), new Date(Date.now() - 31 * 60_000))
    }
    writeFileSync(recreations, (vm.recreatedBeforeRun ?? []).join("\n"))
    writeFileSync(imageContainers, (vm.imageContainers ?? []).map((id) => `${id}\n`).join(""))
    if (vm.existingUsesImage) writeFileSync(slotUsesImage, "")
    if (vm.existingImage) writeFileSync(slot, vm.existingImage)
    if (vm.imagePulled) writeFileSync(path.join(images, "image"), "")
    if (vm.stubLoaded) writeFileSync(path.join(images, "stub"), vm.stubLoaded)
    for (const name of vm.boatSavedImages ?? []) writeFileSync(path.join(boatImages, `${name}.tar`), "")
    for (const tree of IMAGE_TREES) {
      mkdirSync(path.join(rootfs, tree), { recursive: true })
      writeFileSync(path.join(rootfs, tree, `${tree}-from-image`), "")
    }
    mkdirSync(path.join(rootfs, "root", ".cache"), { recursive: true })
    writeFileSync(path.join(rootfs, "root", ".cache", "cached"), "")
    for (const image of vm.seededImages ?? []) {
      const trees = path.join(persistentRoot, treesDirectory(image))
      mkdirSync(trees, { recursive: true })
      writeFileSync(path.join(trees, "image.env"), "PATH=/usr/bin\n")
      writeFileSync(path.join(trees, "stub.tar"), image)
      writeFileSync(path.join(trees, ".complete"), "")
    }
    for (const image of vm.seededWithoutStub ?? []) {
      const trees = path.join(persistentRoot, treesDirectory(image))
      for (const tree of IMAGE_TREES) mkdirSync(path.join(trees, tree), { recursive: true })
      writeFileSync(path.join(trees, "root", ".user-dotfile"), "mine")
      mkdirSync(path.join(trees, "usr", "local", "lib", "node_modules", "cowsay"), { recursive: true })
      writeFileSync(path.join(trees, ".complete"), "")
    }
    if (vm.persistentRootReadOnly) {
      mkdirSync(persistentRoot, { recursive: true })
      chmodSync(persistentRoot, 0o555)
    }
    const tool = (name: string, body: string) => {
      writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`)
      chmodSync(path.join(bin, name), 0o755)
    }
    tool("timeout", 'shift\nexec "$@"')
    // util-linux `flock -w <s> <fd>` takes flock(2) on the descriptor the calling shell holds, so the lock lasts as long as that shell.
    tool("flock", vm.bootLockHeld ? "exit 1" : `exec perl -e 'use Fcntl qw(:flock); open(my $fh, ">&=", $ARGV[1]) or die; my $until = time + $ARGV[0]; until (flock($fh, LOCK_EX | LOCK_NB)) { exit 1 if time >= $until; select(undef, undef, undef, 0.02) }' "$2" "$3"`)
    // Root may write into the persistent root; the plain VM user may not.
    tool("sudo", `echo "sudo $1 $2" >> ${log}\nchmod u+w ${persistentRoot} 2>/dev/null\n"$@"\nrc=$?\nchmod ${vm.persistentRootReadOnly ? "u-w" : "u+w"} ${persistentRoot} 2>/dev/null\nexit $rc`)
    tool("docker", [
      `echo "$*" >> ${log}`,
      `for last; do :; done`,
      `case "$1" in`,
      `  info) n=$(($(cat ${dir}/info 2>/dev/null || echo 0) + 1)); echo $n > ${dir}/info; [ $n -gt ${vm.daemonUpAfter ?? 0} ] ;;`,
      `  pull) touch ${images}/image ;;`,
      `  rmi) if [ -s ${imageContainers} ] || [ -f ${slotUsesImage} ]; then echo 'conflict: unable to delete (must be forced) - container is using its referenced image' >&2; exit 1; fi; rm ${images}/image ;;`,
      `  ps) cat ${imageContainers} ;;`,
      `  image) case "$last" in`,
      `    ${STUB_IMAGE}) [ -f ${images}/stub ] && cat ${images}/stub ;;`,
      `    *) [ -f ${images}/image ] || exit 1; case "$*" in *Env*) printf 'PATH=/usr/local/bin:/usr/bin\\nLANG=C.UTF-8\\n' ;; *WorkingDir*) echo /workspace ;; *.Id*) echo ${IMAGE_ID} ;; esac ;;`,
      `  esac ;;`,
      `  container) [ -f ${slot} ] && { [ "$3" != --format ] || cat ${slot}; } ;;`,
      `  rm) for a; do case "$a" in rm|-f) ;; claxedo-seed) rm -f ${seedSlot} ;; claxedo-runtime) rm -f ${slot} ${slotUsesImage} ;; *) sed -i.bak "/^$a$/d" ${imageContainers} ;; esac; done ;;`,
      `  create) [ -f ${images}/image ] || exit 1; if [ -f ${seedSlot} ]; then echo 'Conflict. The container name "/claxedo-seed" is already in use' >&2; exit 125; fi; touch ${seedSlot} ;;`,
      `  cp) ${vm.seedFails ? "echo 'stream broke' >&2; exit 1" : `/bin/sleep 0.05; [ -f ${seedSlot} ] || { echo 'No such container: claxedo-seed' >&2; exit 1; }; tree=\${2#claxedo-seed:/}; tar -cf - -C ${rootfs} "$tree"`} ;;`,
      `  import) for a; do file=$prev; prev=$a; case "$a" in "LABEL claxedo.image="*) echo "\${a#LABEL claxedo.image=}" > ${images}/stub.next.$$ ;; esac; done`,
      `    tar -tf "$file" >/dev/null && cp "$file" ${images}/stub-root.tar && mv ${images}/stub.next.$$ ${images}/stub ;;`,
      `  save) cp ${images}/stub "$3" ;;`,
      `  load) cp "$3" ${images}/stub ;;`,
      `  run) next=$(head -n 1 ${recreations}); if [ -n "$next" ]; then echo "$next" > ${slot}; sed -i.bak 1d ${recreations}; fi`,
      `      if [ -f ${slot} ]; then echo 'docker: Error response from daemon: Conflict. The container name "/claxedo-runtime" is already in use by container "68fb48f4da56". You have to remove (or rename) that container to be able to reuse that name.' >&2; ${vm.recreatedVanishes ? `rm ${slot}; ` : ""}exit 125; fi`,
      `      ${vm.runFails ? "echo 'invalid mount' >&2; exit 125" : ":"}`,
      `      prev=; for a; do [ "$prev" = --env-file ] && { [ -f "$a" ] || exit 125; }; prev=$a; done`,
      `      cp ${images}/stub ${slot} ;;`,
      `  start) [ -f ${slot} ] ;;`,
      `esac`,
    ].join("\n"))
    tool("sleep", `echo "sleep $1" >> ${log}`)
  }
  // The VM's init binary, Boat's image archive directory and the boot lock live at fixed paths the script names; the test's copies stand in under the directory the script is run from.
  const script = (command: string) => command
    .replace(/\[ -x \/usr\/libexec\/docker\/docker-init \]/, `[ -f ${path.join(dir, "docker-init")} ]`)
    .replaceAll("/var/lib/ascii-docker-images", boatImages)
    .replaceAll("/run/lock/claxedo-boot.lock", bootLock)
  const shell = { cwd: dir, env: { PATH: `${bin}:/usr/bin:/bin`, TMPDIR: path.join(dir, "tmp") } }
  // Boat's file channel writes what a boot stages before its commands run.
  const stage = (commands: StartCommands) => { for (const file of commands.staged) writeFileSync(path.join(dir, file), file) }
  // The unpacking tar runs in a pipe beside `docker cp`, so its place in the log is not fixed; the trees it wrote are asserted instead.
  const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => line.split(" ").slice(0, 2).join(" ")).filter((call) => call !== "sudo tar")
  const trees = (image: string) => path.join(persistentRoot, treesDirectory(image))
  const read = (file: string) => existsSync(file) ? readFileSync(file, "utf8").trim() : undefined
  return {
    dir, script, shell, stage, calls, trees,
    image: () => read(slot),
    imagePulled: () => existsSync(path.join(images, "image")),
    stub: () => read(path.join(images, "stub")),
    stubRoot: () => spawnSync("tar", ["-tvf", path.join(images, "stub-root.tar")], { encoding: "utf8" }).stdout.split("\n").filter(Boolean),
    boatSavedImages: () => readdirSync(boatImages),
  }
}

function runStartCommand(commands: StartCommands, vm: Vm) {
  const vmState = vmFixture(vm)
  vmState.stage(commands)
  const sh = (command: string) => spawnSync("sh", ["-c", vmState.script(command)], { ...vmState.shell, encoding: "utf8" })
  const prepared = sh(commands.prepare)
  const started = prepared.status === 0 ? sh(commands.start) : undefined
  return { ...vmState, prepared: prepared.status, started: started?.status, stderr: `${prepared.stderr}${started?.stderr ?? ""}`, calls: vmState.calls() }
}

/** Boots of one machine run side by side, each its preparation then its start, as two runners of one workspace's start do. */
async function runStartsConcurrently(boots: StartCommands[], vm: Vm) {
  const vmState = vmFixture(vm)
  for (const boot of boots) vmState.stage(boot)
  const sh = (command: string) => new Promise<{ status: number | null; stderr: string }>((resolve) => {
    const child = spawn("sh", ["-c", vmState.script(command)], vmState.shell)
    let stderr = ""
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString() })
    child.on("close", (status) => resolve({ status, stderr }))
  })
  const results = await Promise.all(boots.map(async (boot) => {
    const prepared = await sh(boot.prepare)
    const started = prepared.status === 0 ? await sh(boot.start) : undefined
    return { prepared: prepared.status, started: started?.status, stderr: `${prepared.stderr}${started?.stderr ?? ""}` }
  }))
  return { ...vmState, results, calls: vmState.calls() }
}

async function startCommands(): Promise<StartCommands> {
  const boat = fakeBoat()
  const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: boat.fetchImpl, healthIntervalMs: 0 })
  await driver.ensureHost(ensureInput())
  const prepare = commandsOf(boat.calls).find((c) => c.includes("docker info"))
  const start = commandsOf(boat.calls).find((c) => c.includes("docker run -d"))
  if (!prepare || !start) throw new Error("no container start commands")
  return { prepare, start, staged: boat.calls.filter((c) => c.path.endsWith("/files")).map((c) => c.body.path as string) }
}

const commandsOf = (calls: Call[]) => calls.filter((c) => c.path.endsWith("/commands")).map((c) => c.body.command as string)

describe("boat sandbox driver", () => {
  test.each(["transport", "http", "exit"] as const)("staged file cleanup %s failure prevents publishing the runtime", async (failure) => {
    const boat = fakeBoat()
    const driver = createBoatSandboxDriver({
      apiKey: "k",
      image: IMAGE,
      healthIntervalMs: 0,
      registryAuth: { server: "registry.example.com", username: "builder", password: "synthetic-registry-pw" },
      fetchImpl: async (url, init) => {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
        if (body?.command?.startsWith("rm -f .claxedo-runtime-env.")) {
          if (failure === "transport") throw new Error("cleanup connection refused")
          if (failure === "http") return Response.json({ ok: false, code: "forbidden", message: "cleanup denied" }, { status: 403 })
          return Response.json({ ok: true, ...commandFinished({ exitCode: 1, stderr: "cleanup denied" }) })
        }
        return boat.fetchImpl(url, init)
      },
    })
    await expect(driver.ensureHost(ensureInput())).rejects.toThrow()
    expect(commandsOf(boat.calls).some(isHostCommand)).toBe(false)
  })

  test("persists a created sandbox before readiness polling and resumes it after manager restart", async () => {
    let store = createMemoryLeaseStore()
    const boat = fakeBoat({ states: ["provisioning", "ready"] })
    let observedId: string | undefined
    let observedStatus: string | undefined
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, provisionTimeoutMs: 0, provisionIntervalMs: 0,
      fetchImpl: async (url, init) => {
        if (url.endsWith(`/sandboxes/${ID}`) && (!init?.method || init.method === "GET")) {
          const lease = await store.get("ws1")
          observedId = lease?.sandboxId
          observedStatus = lease?.status
        }
        return boat.fetchImpl(url, init)
      } })
    const options = { leaseStore: store, driver, onEgressUnenforced: () => {} }
    expect((await createSandboxManager(options).ensure("ws1", { homeRegion: "eu" })).status).toBe("provisioning")
    expect(observedId).toBe(ID)
    expect(observedStatus).toBe("acquiring")
    expect((await store.get("ws1"))?.url).toBeUndefined()
    store = createMemoryLeaseStore(await store.list())
    expect((await createSandboxManager({ ...options, leaseStore: store }).ensure("ws1", { homeRegion: "eu" })).status).toBe("ready")
    expect(boat.calls.filter((call) => call.path === "/sandboxes" && call.method === "POST")).toHaveLength(1)
    expect(boat.calls.filter((call) => call.path.endsWith("/resume"))).toHaveLength(0)
  })

  test("a failed readiness read retains the sandbox identity beyond acquisition staleness", async () => {
    const store = createMemoryLeaseStore()
    const boat = fakeBoat()
    let fail = true
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: async (url, init) => {
      if (fail && url.endsWith(`/sandboxes/${ID}`)) {
        fail = false
        return Response.json({ ok: false, code: "internal_error", message: "provider down" }, { status: 500 })
      }
      return boat.fetchImpl(url, init)
    } })
    const manager = createSandboxManager({ leaseStore: store, driver, staleAfterMs: 0, retryDelayMs: () => 0, onEgressUnenforced: () => {} })
    expect((await manager.ensure("ws1", { homeRegion: "eu" })).status).toBe("unavailable")
    expect((await store.get("ws1"))?.sandboxId).toBe(ID)
    expect((await manager.ensure("ws1", { homeRegion: "eu" })).status).toBe("ready")
    expect(boat.calls.filter((call) => call.path === "/sandboxes" && call.method === "POST")).toHaveLength(1)
  })

  test("a lost create acknowledgement is retried under the same idempotency key", async () => {
    const boat = fakeBoat()
    let lost = true
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, healthIntervalMs: 0, fetchImpl: async (url, init) => {
      if (lost && url.endsWith("/sandboxes")) {
        lost = false
        throw new Error("socket hang up")
      }
      return boat.fetchImpl(url, init)
    } })
    expect(await driver.ensureHost(ensureInput())).toMatchObject({ provisioning: true })
    expect(await driver.ensureHost(ensureInput())).toMatchObject({ sandboxId: ID })
    expect(boat.calls.filter((call) => call.path === "/sandboxes").map((call) => call.headers["Idempotency-Key"])).toEqual(["claxedo:ws1:1"])
  })

  test("a rejected resource write deletes the created sandbox, confirming its id, before propagating the handoff error", async () => {
    const boat = fakeBoat()
    const handoffError = new Error("epoch lost")
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: boat.fetchImpl })
    await expect(driver.ensureHost(ensureInput({ machineClass: "large", onResource: async () => { throw handoffError } }))).rejects.toBe(handoffError)
    expect(boat.calls.map(({ path, method, body }) => ({ path, method, body }))).toEqual([
      { path: "/sandboxes", method: "POST", body: { noEnv: true, ttlSeconds: BOOT_TTL_SECONDS, type: "large" } },
      { path: `/sandboxes/${ID}`, method: "DELETE", body: undefined },
    ])
    expect(boat.calls[1].headers).toMatchObject({ "X-Ascii-Confirm-Delete": ID, Authorization: "Bearer k" })
  })

  test.each(["transport", "http"])("a rejected resource write surfaces both handoff and deletion %s errors", async (failure) => {
    const boat = fakeBoat()
    const handoffError = new Error("epoch lost")
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: async (url, init) => {
      const response = await boat.fetchImpl(url, init)
      if (init?.method !== "DELETE") return response
      if (failure === "transport") throw new Error("delete connection refused")
      return Response.json({ ok: false, code: "forbidden", message: "delete denied for secret-path" }, { status: 403 })
    } })
    const error = await driver.ensureHost(ensureInput({ onResource: async () => { throw handoffError } })).then(
      () => { throw new Error("expected handoff to fail") },
      (error: unknown) => error,
    )
    expect(error).toBeInstanceOf(AggregateError)
    const aggregate = error as AggregateError
    expect(aggregate.message).toMatch(new RegExp(`${ID}.*handoff.*delet`))
    expect(aggregate.errors).toHaveLength(2)
    expect(aggregate.errors[0]).toBe(handoffError)
    expect(aggregate.errors[1]).toMatchObject({ code: failure === "transport" ? "transport_failed" : "forbidden" })
    expect(aggregate.errors[1].message).not.toContain("secret-path")
  })

  test.each(["persistence failure", "lost epoch"])("manager resource handoff cleans up the sandbox after %s", async (failure) => {
    const store = createMemoryLeaseStore()
    const boat = fakeBoat()
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: boat.fetchImpl })
    const manager = createSandboxManager({
      driver,
      onEgressUnenforced: () => {},
      leaseStore: {
        ...store,
        async recordTarget(workspaceId, epoch, target) {
          if (failure === "persistence failure") throw new Error("storage unavailable")
          await store.acquire(workspaceId, { homeRegion: "eu", driver: "boat", staleAfterMs: 0 })
          return store.recordTarget(workspaceId, epoch, target)
        },
      },
    })
    expect(await manager.ensure("ws1", { homeRegion: "eu" })).toMatchObject({
      status: "unavailable",
      error: failure === "persistence failure" ? "storage unavailable" : "runtime_lease_changed",
    })
    expect((await store.get("ws1"))?.sandboxId).toBeUndefined()
    expect(boat.calls.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "POST", path: "/sandboxes" },
      { method: "DELETE", path: `/sandboxes/${ID}` },
    ])
  })

  test.each(["auth", "malformed", "wrong type", "boot", "missing"])("resume propagates %s failure without creating a replacement", async (failure) => {
    const boat = fakeBoat({ states: ["archived", "ready"] })
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: async (url, init) => {
      if (failure === "auth" && url.endsWith("/resume")) return Response.json({ ok: false, code: "unauthorized", message: "Unauthorized" }, { status: 401 })
      if (failure === "missing" && url.endsWith("/resume")) return Response.json({ ok: false, code: "not_found", message: "gone" }, { status: 404 })
      if (failure === "malformed" && url.endsWith(`/sandboxes/${ID}`)) return Response.json({ ok: true, type: "sandbox.info" })
      if (failure === "wrong type" && url.endsWith(`/sandboxes/${ID}`)) return Response.json({ ok: true, type: "box.info", sandbox: sandboxRecord("ready") })
      if (failure === "boot" && url.endsWith("/commands")) return Response.json({ ok: true, ...commandFinished({ exitCode: 1, stderr: "boot failed" }) })
      return boat.fetchImpl(url, init)
    } })
    await expect(driver.resumeHost!({
      lease: sandboxLease({ workspaceId: "ws1", sandboxId: ID, hostId: "boat-ws1", url: "https://runtime.test", status: "stopped" }),
      ensure: ensureInput(),
    })).rejects.toThrow()
    expect(boat.calls.filter((call) => call.path === "/sandboxes" && call.method === "POST")).toHaveLength(0)
  })

  test("exposes relay metadata and boat identity", () => {
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: async () => new Response("{}") })
    expect(driver.id).toBe("boat")
    expect(driver.metadata).toMatchObject({
      driverRunsIn: ["worker", "node"],
      hostStopBehavior: "suspends-host",
      hostResumeBehavior: "same-host",
      targetAccess: "relay",
      secretBrokering: "none",
    })
  })

  test("boots a sandbox: create → poll ready → docker run → public host → health → url", async () => {
    const boat = fakeBoat({ states: ["provisioning", "ready"] })
    const driver = createBoatSandboxDriver({
      apiKey: "k",
      image: IMAGE,
      fetchImpl: boat.fetchImpl,
      provisionIntervalMs: 0,
      healthIntervalMs: 0,
      controlEnv: { managementJwksUrl: "https://api.example.test/.well-known/jwks.json" },
    })

    const target = await driver.ensureHost(ensureInput())
    if ("provisioning" in target) throw new Error("unexpected provisioning")
    expect(target.sandboxId).toBe(ID)
    expect(target.url).toBe("https://machine-2593.on.boat.dev")
    expect(target.driver).toEqual({ id: "boat", resourceId: ID })

    const create = boat.calls.find((c) => c.path === "/sandboxes" && c.method === "POST")
    expect(create?.body).toEqual({ noEnv: true, ttlSeconds: BOOT_TTL_SECONDS })
    expect(create?.headers).toMatchObject({ "Idempotency-Key": "claxedo:ws1:1", Authorization: "Bearer k" })
    // The deadline the create set is removed once the runtime answers, before its URL is published.
    expect(ttlUpdates(boat.calls)).toEqual([{ ttlSeconds: null }])
    const order = boat.calls.map((c) => c.method === "PATCH" ? "ttl" : c.body?.command?.includes("/global/health") ? "health" : c.body?.command?.startsWith("host url") ? "url" : undefined).filter(Boolean)
    expect(order).toEqual(["health", "ttl", "url"])
    const run = boat.calls.find((c) => c.path.endsWith("/commands") && c.body.command.includes("docker run -d"))
    expect(run?.body.timeoutSeconds).toBe(120)
    const prepare = boat.calls.find((c) => c.path.endsWith("/commands") && c.body.command.includes("docker info"))
    expect(prepare?.body.timeoutSeconds).toBe(600)
    const trees = `"$(pwd)/claxedo-persistent/image-ghcr.io-test-sandbox-1"`
    expect(prepare?.body.command).toContain(`if ! { [ -f ${trees}/.complete ] && [ -f ${trees}/stub.tar ] && [ -f ${trees}/image.env ]; }; then { docker image inspect 'ghcr.io/test/sandbox:1' >/dev/null 2>&1 || docker pull 'ghcr.io/test/sandbox:1'`)
    expect(prepare?.body.command).toContain("sudo rm -rf")
    expect(prepare?.body.command).toContain("sudo mkdir -p")
    expect(prepare?.body.command).toContain(`docker import --change "WORKDIR $workdir" --change 'LABEL claxedo.image=ghcr.io/test/sandbox:1' "$stub/skeleton.tar" claxedo-runtime-stub`)
    expect(prepare?.body.command).not.toContain("docker rmi")
    expect(run?.body.command).toContain("docker rmi 'ghcr.io/test/sandbox:1'")
    expect(run?.body.command).toContain(`sudo rm -f /var/lib/ascii-docker-images/"\${id#sha256:}".tar`)
    expect(run?.body.command).toContain("docker run -d --name claxedo-runtime --hostname 'ws1' -p 2593:2593 -v /usr/libexec/docker/docker-init:/claxedo-init:ro ")
    expect(run?.body.command).toContain(`--env-file "$(pwd)/claxedo-persistent/image-ghcr.io-test-sandbox-1"/image.env `)
    expect(run?.body.command).toContain("--security-opt seccomp=unconfined --security-opt apparmor=unconfined --entrypoint /claxedo-init claxedo-runtime-stub -- sh -lc ")
    expect(run?.body.command).toContain(`[ "$(docker container inspect --format '{{index .Config.Labels "claxedo.image"}}' claxedo-runtime 2>/dev/null)" = 'ghcr.io/test/sandbox:1' ]`)
    expect(run?.body.command).toContain(".claxedo-runtime-env:/run/claxedo-runtime.env:ro")
    for (const tree of IMAGE_TREES) {
      expect(run?.body.command).toContain(`-v "$(pwd)/claxedo-persistent/image-ghcr.io-test-sandbox-1"/${tree}:/${tree} `)
    }
    expect(run?.body.command).toContain(`-v "$(pwd)/claxedo-persistent/workspace":'/workspace'`)
    expect(run?.body.command).toContain(`-v "$(pwd)/claxedo-persistent/claxedo":'/root/.claxedo'`)
    expect(run?.body.command).toContain(`-v "$(pwd)/claxedo-persistent/workspace-runtime":'/root/.workspace-runtime'`)
    expect(run?.body.command).not.toContain("--env ")
    const envWrite = boat.calls.find((c) => c.path.endsWith("/files") && c.body?.path?.startsWith(".claxedo-runtime-env."))
    expect(envWrite?.body).toMatchObject({ encoding: "utf8" })
    expect(envWrite?.body?.content).toContain("export WORKSPACE_RUNTIME_WORKSPACE_ID='ws1'")
    expect(envWrite?.body?.content).toContain("export WORKSPACE_RUNTIME_MANAGEMENT_JWKS_URL='https://api.example.test/.well-known/jwks.json'")
    expect(commandsOf(boat.calls)).toContain(`exec 9>>/run/lock/claxedo-boot.lock && { flock -w 60 9 || { echo "another boot of this machine held /run/lock/claxedo-boot.lock for 60 s" >&2; exit 1; }; } && host 2593 --public`)
    expect(commandsOf(boat.calls)).toContain("host url 2593 --public")
  })

  test("the preparation starts no container of the image, so Boat records none it would pull the image again to recreate", async () => {
    const { prepare } = await startCommands()
    expect(prepare).toContain("docker create --name claxedo-seed 'ghcr.io/test/sandbox:1' true")
    expect(prepare).not.toMatch(/docker (run|start)\b/)
  })

  test("reports its image ready once the runtime container has started, before the runtime is published", async () => {
    const boat = fakeBoat({ states: ["ready"] })
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: boat.fetchImpl, provisionIntervalMs: 0, healthIntervalMs: 0 })
    let seen: string[] = []

    await driver.ensureHost({ ...ensureInput(), onImageReady: async () => { seen = commandsOf(boat.calls) } })

    expect(seen.some((command) => command.includes("docker run -d"))).toBe(true)
    expect(seen.some((command) => command.endsWith("host 2593 --public"))).toBe(false)
  })

  test("reports its machine ready once Boat says a created or resumed sandbox is ready, before anything is written to it", async () => {
    const created = fakeBoat({ states: ["provisioning", "ready"] })
    const createDriver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: created.fetchImpl, provisionIntervalMs: 0, healthIntervalMs: 0 })
    let atCreate: string[] = []
    await createDriver.ensureHost({ ...ensureInput(), onMachineReady: async () => { atCreate = created.calls.map((c) => `${c.method} ${c.path}`) } })
    expect(atCreate).toEqual(["POST /sandboxes", `GET /sandboxes/${ID}`, `GET /sandboxes/${ID}`])

    const resumed = fakeBoat({ states: ["archived", "provisioning", "ready"] })
    const resumeDriver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: resumed.fetchImpl, provisionIntervalMs: 0, healthIntervalMs: 0 })
    let atResume: string[] = []
    await resumeDriver.resumeHost?.({
      lease: sandboxLease({ workspaceId: "ws1", sandboxId: ID, hostId: "boat-ws1", url: "https://runtime.test", status: "stopped" }),
      ensure: { ...ensureInput(), onMachineReady: async () => { atResume = resumed.calls.map((c) => `${c.method} ${c.path}`) } },
    })
    expect(atResume).toEqual([`GET /sandboxes/${ID}`, `POST /sandboxes/${ID}/resume`, `GET /sandboxes/${ID}`, `GET /sandboxes/${ID}`])
  })

  test("refuses a published URL that still carries Boat's access token", async () => {
    const boat = fakeBoat({ hostUrl: "https://machine-2593.on.boat.dev?_token=synthetic-host-token" })
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: boat.fetchImpl, healthIntervalMs: 0 })
    const failure = await driver.ensureHost(ensureInput()).then(() => undefined, (error: unknown) => error as Error)
    expect(failure?.message).toMatch(/ungated HTTPS URL/)
    expect(failure?.message).not.toContain("synthetic-host-token")
  })

  const RELAY_NOT_STOPPED = "Error: API error (500): The sandbox could not stop the localhost relay of this port. Try again."
  const publishes = (calls: Call[]) => commandsOf(calls).filter((command) => command.endsWith("&& host 2593 --public"))

  test("a port publish Boat answers could not stop the port's relay is tried once more", async () => {
    const boat = fakeBoat({ hostPublishFailures: [RELAY_NOT_STOPPED] })
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: boat.fetchImpl, healthIntervalMs: 0 })
    expect(await driver.ensureHost(ensureInput())).toMatchObject({ url: "https://machine-2593.on.boat.dev" })
    expect(publishes(boat.calls)).toHaveLength(2)
  })

  test.each([
    ["the relay answer twice", [RELAY_NOT_STOPPED, RELAY_NOT_STOPPED], 2],
    ["any other failure", ["Error: API error (500): The port is not listening."], 1],
  ])("a port publish that fails with %s fails the boot", async (_kind, failures, attempts) => {
    const boat = fakeBoat({ hostPublishFailures: [...failures] })
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: boat.fetchImpl, healthIntervalMs: 0 })
    await expect(driver.ensureHost(ensureInput())).rejects.toThrow(`host publish failed (exit 1): ${failures.at(-1)}`)
    expect(publishes(boat.calls)).toHaveLength(attempts)
  })

  const PULL_CALLS = ["image inspect", `pull ${IMAGE}`]
  const TREE_SEED_CALLS = ["sudo rm", "sudo mkdir", "rm -f", "create --name", ...IMAGE_TREES.map((tree) => `cp claxedo-seed:/${tree}`), "rm claxedo-seed", "sudo touch"]
  const STUB_SEED_CALLS = ["image inspect", "image inspect", "import --change", "save -o", "sudo mv"]
  const SEED_CALLS = [...PULL_CALLS, ...TREE_SEED_CALLS, ...STUB_SEED_CALLS]
  const IMAGE_REMOVAL_CALLS = ["image inspect", "ps -aq", "image inspect", `rmi ${IMAGE}`, "sudo rm"]

  onVm("a fresh VM waits for the Docker daemon, pulls the image, seeds its trees and a stub of its root as root, removes the image and Boat's saved copy of it, then creates the runtime container from the stub, leaving the workspace bind source for Docker to create", async () => {
    const run = runStartCommand(await startCommands(), { daemonUpAfter: 2, boatSavedImages: [IMAGE_ID.replace("sha256:", ""), "other-image"] })
    expect(run.stderr).toBe("")
    expect(run.prepared).toBe(0)
    expect(run.started).toBe(0)
    expect(run.calls).toEqual(["info", "sleep 1", "info", "sleep 1", "info", ...SEED_CALLS, "image inspect", "sudo find", "container inspect", "rm -f", "run -d", ...IMAGE_REMOVAL_CALLS])
    for (const tree of IMAGE_TREES) expect(existsSync(path.join(run.trees(IMAGE), tree, `${tree}-from-image`))).toBe(true)
    expect(existsSync(path.join(run.trees(IMAGE), "root", ".cache"))).toBe(false)
    expect(readFileSync(path.join(run.trees(IMAGE), "image.env"), "utf8")).toBe("PATH=/usr/local/bin:/usr/bin\nLANG=C.UTF-8\n")
    expect(readFileSync(path.join(run.trees(IMAGE), "stub.tar"), "utf8").trim()).toBe(IMAGE)
    expect(existsSync(path.join(run.trees(IMAGE), ".complete"))).toBe(true)
    expect(run.imagePulled()).toBe(false)
    expect(run.boatSavedImages()).toEqual(["other-image.tar"])
    expect(run.image()).toBe(IMAGE)
    const root = run.stubRoot()
    for (const link of ["bin", "lib", "lib64", "sbin"]) expect(root).toContainEqual(expect.stringMatching(new RegExp(`^l.* 0(?:/| +)0 .* \\./${link} -> usr/${link}$`)))
    for (const directory of ["boot", "dev", "media", "mnt", "proc", "run", "sys", ...IMAGE_TREES]) {
      expect(root).toContainEqual(expect.stringMatching(new RegExp(`^d.* 0(?:/| +)0 .* \\./${directory}/?$`)))
    }
    expect(root).toContainEqual(expect.stringMatching(/^drwxrwxrwt.* 0(?:\/| +)0 .* \.\/tmp\/?$/))
    expect(existsSync(path.join(run.dir, "claxedo-persistent", "workspace"))).toBe(false)
  })

  onVm("a sandbox that booted before the trees existed has a persistent root only root may write into, and the seed lands there all the same", async () => {
    const run = runStartCommand(await startCommands(), { persistentRootReadOnly: true })
    expect(run.stderr).not.toContain("Permission denied")
    expect(run.prepared).toBe(0)
    expect(run.started).toBe(0)
    expect(run.calls).toContain("sudo mkdir")
    expect(existsSync(path.join(run.trees(IMAGE), ".complete"))).toBe(true)
  })

  onVm("a resume finds the image's trees seeded, pulls nothing, loads the stub Docker lost with the stop and creates the container again", async () => {
    const run = runStartCommand(await startCommands(), { seededImages: [IMAGE] })
    expect(run.started).toBe(0)
    expect(run.calls).toEqual(["info", "image inspect", "load -i", "sudo find", "container inspect", "rm -f", "run -d", "image inspect"])
    expect(run.imagePulled()).toBe(false)
    expect(run.image()).toBe(IMAGE)
  })

  onVm("a stub Docker still holds for the image is not loaded again, and one of another image is replaced by this image's", async () => {
    const kept = runStartCommand(await startCommands(), { seededImages: [IMAGE], stubLoaded: IMAGE })
    expect(kept.started).toBe(0)
    expect(kept.calls).not.toContain("load -i")
    const replaced = runStartCommand(await startCommands(), { seededImages: [IMAGE], stubLoaded: "ghcr.io/test/sandbox:0" })
    expect(replaced.started).toBe(0)
    expect(replaced.calls).toContain("load -i")
    expect(replaced.stub()).toBe(IMAGE)
  })

  onVm("trees an earlier driver seeded without a stub or env keep their files, get both from the image, and the image goes once the runtime that used it is replaced", async () => {
    const run = runStartCommand(await startCommands(), {
      seededWithoutStub: [IMAGE], existingImage: "(no label)", existingUsesImage: true, boatSavedImages: [IMAGE_ID.replace("sha256:", "")],
    })
    expect(run.stderr).toBe("")
    expect(run.started).toBe(0)
    expect(run.calls).toEqual(["info", ...PULL_CALLS, ...STUB_SEED_CALLS, "image inspect", "sudo find", "container inspect", "rm -f", "run -d", ...IMAGE_REMOVAL_CALLS])
    expect(readFileSync(path.join(run.trees(IMAGE), "root", ".user-dotfile"), "utf8")).toBe("mine")
    expect(existsSync(path.join(run.trees(IMAGE), "usr", "local", "lib", "node_modules", "cowsay"))).toBe(true)
    expect(existsSync(path.join(run.trees(IMAGE), "stub.tar"))).toBe(true)
    expect(existsSync(path.join(run.trees(IMAGE), "image.env"))).toBe(true)
    expect(run.image()).toBe(IMAGE)
    expect(run.imagePulled()).toBe(false)
    expect(run.boatSavedImages()).toEqual([])
  })

  onVm("trees with a stub but no env get the env and stub again, and nothing else", async () => {
    const commands = await startCommands()
    const first = runStartCommand(commands, { seededImages: [IMAGE] })
    rmSync(path.join(first.trees(IMAGE), "image.env"))
    rmSync(path.join(first.dir, "container"))
    const again = runStartCommand(commands, { dir: first.dir })
    expect(again.started).toBe(0)
    expect(again.calls).toEqual(["info", ...PULL_CALLS, ...STUB_SEED_CALLS, "image inspect", "sudo find", "container inspect", "rm -f", "run -d", ...IMAGE_REMOVAL_CALLS])
    expect(existsSync(path.join(first.trees(IMAGE), "image.env"))).toBe(true)
  })

  onVm("containers of the image other than the runtime, such as a seed container Boat created again, are removed with the image", async () => {
    const run = runStartCommand(await startCommands(), { seededImages: [IMAGE], stubLoaded: IMAGE, imagePulled: true, imageContainers: ["0a1b2c3d"] })
    expect(run.stderr).toBe("")
    expect(run.started).toBe(0)
    expect(run.calls.slice(-6)).toEqual(["image inspect", "ps -aq", "rm -f", "image inspect", `rmi ${IMAGE}`, "sudo rm"])
    expect(run.imagePulled()).toBe(false)
  })

  onVm("two boots of one machine at once seed it once: the second waits for the first's preparation, then finds the seed complete and the first's container", async () => {
    const run = await runStartsConcurrently([await startCommands(), await startCommands()], {})
    for (const result of run.results) {
      expect(result.stderr).toBe("")
      expect(result.prepared).toBe(0)
      expect(result.started).toBe(0)
    }
    expect(run.calls.filter((call) => call.startsWith("pull "))).toHaveLength(1)
    expect(run.calls.filter((call) => call === "cp claxedo-seed:/usr")).toHaveLength(1)
    expect(run.calls.filter((call) => call === "run -d")).toHaveLength(1)
    expect(run.calls.filter((call) => call === "start claxedo-runtime")).toHaveLength(1)
    expect(existsSync(path.join(run.trees(IMAGE), ".complete"))).toBe(true)
    expect(run.image()).toBe(IMAGE)
  })

  onVm("a boot that cannot take the machine's boot lock in time fails with the reason and changes nothing", async () => {
    const run = runStartCommand(await startCommands(), { bootLockHeld: true })
    expect(run.prepared).not.toBe(0)
    expect(run.stderr).toContain("another boot of this machine held /run/lock/claxedo-boot.lock".replace("/run/lock/claxedo-boot.lock", path.join(run.dir, "boot.lock")))
    expect(run.calls).toEqual([])
  })

  test("each boot stages its env and registry password under names of its own, so one boot's cleanup never removes another's", async () => {
    const boat = fakeBoat()
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: boat.fetchImpl, healthIntervalMs: 0,
      registryAuth: { server: "registry.example.com", username: "builder", password: "synthetic-registry-pw" } })
    await driver.ensureHost(ensureInput())
    await driver.ensureHost(ensureInput())
    const staged = boat.calls.filter((c) => c.path.endsWith("/files")).map((c) => c.body.path as string)
    expect(staged).toHaveLength(4)
    expect(new Set(staged).size).toBe(4)
    const cleanups = commandsOf(boat.calls).filter((command) => command.startsWith("rm -f .claxedo-runtime-env."))
    expect(cleanups).toEqual([`rm -f ${staged[0]} ${staged[1]}`, `rm -f ${staged[2]} ${staged[3]}`])
  })

  onVm("a boot moves the env it staged into the container's place and removes what boots that never finished staged", async () => {
    const commands = await startCommands()
    const stale = [".claxedo-runtime-env.dead-boot", ".claxedo-registry-password.dead-boot"]
    const run = runStartCommand(commands, { seededImages: [IMAGE], stubLoaded: IMAGE, staleStaged: stale })
    expect(run.started).toBe(0)
    for (const file of stale) expect(existsSync(path.join(run.dir, file))).toBe(false)
    const [env] = commands.staged
    expect(existsSync(path.join(run.dir, env))).toBe(false)
    expect(readFileSync(path.join(run.dir, ".claxedo-runtime-env"), "utf8")).toBe(env)
  })

  onVm("a seed that was interrupted before it was marked complete is redone from scratch", async () => {
    const commands = await startCommands()
    const partial = runStartCommand(commands, { seededImages: [IMAGE] })
    rmSync(path.join(partial.dir, "container"))
    rmSync(path.join(partial.trees(IMAGE), ".complete"))
    writeFileSync(path.join(partial.trees(IMAGE), "half-written"), "")
    const again = runStartCommand(commands, { dir: partial.dir })
    expect(again.started).toBe(0)
    expect(again.calls).toContain(`pull ${IMAGE}`)
    expect(existsSync(path.join(partial.trees(IMAGE), "half-written"))).toBe(false)
    expect(existsSync(path.join(partial.trees(IMAGE), "usr", "usr-from-image"))).toBe(true)
  })

  onVm("a seed that cannot stream the image's trees ends the preparation, and the container of the previous image keeps running", async () => {
    const run = runStartCommand(await startCommands(), { existingImage: "ghcr.io/test/sandbox:0", seededImages: ["ghcr.io/test/sandbox:0"], seedFails: true })
    expect(run.prepared).not.toBe(0)
    expect(run.started).toBeUndefined()
    expect(run.image()).toBe("ghcr.io/test/sandbox:0")
    expect(run.calls).not.toContain("run -d")
    expect(existsSync(path.join(run.trees(IMAGE), ".complete"))).toBe(false)
    expect(existsSync(run.trees("ghcr.io/test/sandbox:0"))).toBe(true)
  })

  test("a sandbox booted from an older image reads as outdated until its next start boots the deployment's image", async () => {
    const store = createMemoryLeaseStore()
    const boat = fakeBoat()
    const manager = (image: string) => createSandboxManager({
      leaseStore: store,
      driver: createBoatSandboxDriver({ apiKey: "k", image, fetchImpl: boat.fetchImpl, healthIntervalMs: 0 }),
      onEgressUnenforced: () => {},
    })
    expect(await manager("ghcr.io/test/sandbox:0").ensure("ws1", { homeRegion: "eu" })).toMatchObject({ status: "ready", labels: { image: "ghcr.io/test/sandbox:0" } })

    const updated = manager(IMAGE)
    expect(await updated.target("ws1")).toMatchObject({ status: "ready", imageOutdated: true })
    expect(await updated.ensure("ws1", { homeRegion: "eu" })).toMatchObject({ status: "ready", labels: { image: IMAGE } })
    expect(await updated.target("ws1")).not.toHaveProperty("imageOutdated")
    expect(boat.calls.filter((call) => call.path === "/sandboxes" && call.method === "POST")).toHaveLength(1)
  })

  onVm("a start that finds this image's container, which a stop keeps and Boat creates again stopped, only starts it", async () => {
    const run = runStartCommand(await startCommands(), { existingImage: IMAGE, seededImages: [IMAGE], stubLoaded: IMAGE, daemonUpAfter: 1 })
    expect(run.started).toBe(0)
    expect(run.calls).toEqual(["info", "sleep 1", "info", "image inspect", "sudo find", "container inspect", "start claxedo-runtime", "image inspect"])
  })

  onVm("a container of another image is replaced only once the trees of the image this boot names are seeded, and the other image's trees are removed", async () => {
    const run = runStartCommand(await startCommands(), { existingImage: "ghcr.io/test/sandbox:0", seededImages: ["ghcr.io/test/sandbox:0"], stubLoaded: "ghcr.io/test/sandbox:0" })
    expect(run.started).toBe(0)
    expect(run.calls).toEqual(["info", ...SEED_CALLS, "image inspect", "sudo find", "container inspect", "rm -f", "run -d", ...IMAGE_REMOVAL_CALLS])
    expect(existsSync(path.join(run.trees(IMAGE), ".complete"))).toBe(true)
    expect(existsSync(run.trees("ghcr.io/test/sandbox:0"))).toBe(false)
    expect(run.image()).toBe(IMAGE)
  })

  onVm("a create that finds the runtime's name taken by a container Boat created again removes that container and creates the runtime once more", async () => {
    const run = runStartCommand(await startCommands(), { recreatedBeforeRun: [IMAGE], seededImages: [IMAGE], stubLoaded: IMAGE })
    expect(run.started).toBe(0)
    expect(run.calls.slice(3)).toEqual(["container inspect", "rm -f", "run -d", "sleep 1", "rm -f", "run -d", "image inspect"])
    expect(run.image()).toBe(IMAGE)
  })

  onVm("a name clash whose container Boat has removed again by the retry still creates the runtime", async () => {
    const run = runStartCommand(await startCommands(), { recreatedBeforeRun: [IMAGE], recreatedVanishes: true, seededImages: [IMAGE], stubLoaded: IMAGE })
    expect(run.started).toBe(0)
    expect(run.calls.slice(3)).toEqual(["container inspect", "rm -f", "run -d", "sleep 1", "rm -f", "run -d", "image inspect"])
    expect(run.image()).toBe(IMAGE)
  })

  onVm("a name Boat still holds at the first retry is retried until its create has ended", async () => {
    const run = runStartCommand(await startCommands(), { recreatedBeforeRun: [IMAGE, IMAGE], recreatedVanishes: true, seededImages: [IMAGE], stubLoaded: IMAGE })
    expect(run.started).toBe(0)
    expect(run.calls.slice(3)).toEqual(["container inspect", "rm -f", "run -d", "sleep 1", "rm -f", "run -d", "sleep 1", "rm -f", "run -d", "image inspect"])
  })

  onVm("a name taken at each of five creates fails the start with Docker's answer", async () => {
    const run = runStartCommand(await startCommands(), { recreatedBeforeRun: Array(5).fill(IMAGE), seededImages: [IMAGE], stubLoaded: IMAGE })
    expect(run.started).not.toBe(0)
    expect(run.stderr).toContain("is already in use by container")
    expect(run.calls.slice(3)).toEqual(["container inspect", "rm -f", "run -d", ...Array(4).fill(["sleep 1", "rm -f", "run -d"]).flat()])
  })

  onVm("a create that fails for any other reason fails the start without a retry", async () => {
    const run = runStartCommand(await startCommands(), { runFails: true, seededImages: [IMAGE], stubLoaded: IMAGE })
    expect(run.prepared).toBe(0)
    expect(run.started).not.toBe(0)
    expect(run.stderr).toContain("invalid mount")
    expect(run.calls.slice(3)).toEqual(["container inspect", "rm -f", "run -d"])
  })

  test("a preparation that fails is a provider error over a runtime that may still serve; a container start that fails is a boot failure, since nothing serves", async () => {
    const failing = (step: "docker info" | "docker run -d") => {
      const boat = fakeBoat()
      return createBoatSandboxDriver({ apiKey: "k", image: IMAGE, healthIntervalMs: 0, fetchImpl: async (url, init) => {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
        if (body?.command?.includes(step)) return Response.json({ ok: true, ...commandFinished({ exitCode: 1, stderr: "mkdir: cannot create directory: Permission denied" }) })
        return boat.fetchImpl(url, init)
      } })
    }
    const prepared = await failing("docker info").ensureHost(ensureInput()).then(() => undefined, (error: unknown) => error)
    expect(prepared).toBeInstanceOf(Error)
    expect(isSandboxRuntimeBootFailure(prepared)).toBe(false)
    expect((prepared as Error).message).toContain("runtime image preparation failed (exit 1): mkdir: cannot create directory: Permission denied")
    const started = await failing("docker run -d").ensureHost(ensureInput()).then(() => undefined, (error: unknown) => error)
    expect(isSandboxRuntimeBootFailure(started)).toBe(true)
    expect((started as Error).message).toContain("container start failed (exit 1)")
  })

  test("keeps env values and registry credentials out of command strings", async () => {
    const boat = fakeBoat()
    const driver = createBoatSandboxDriver({
      apiKey: "k",
      image: IMAGE,
      fetchImpl: boat.fetchImpl,
      healthIntervalMs: 0,
      registryAuth: { server: "registry.example.com", username: "builder", password: "synthetic-registry-pw" },
      env: () => ({ RUNTIME_SECRET: "synthetic-runtime-secret", PEM: "-----BEGIN-----\nline2\n-----END-----" }),
    })

    const target = await driver.ensureHost(ensureInput({ env: { CALLER_SECRET: "synthetic-caller-secret" } }))
    if ("provisioning" in target) throw new Error("unexpected provisioning")

    const commands = commandsOf(boat.calls)
    for (const command of commands) {
      expect(command).not.toContain("synthetic-runtime-secret")
      expect(command).not.toContain("synthetic-caller-secret")
      expect(command).not.toContain("synthetic-registry-pw")
      expect(command).not.toContain("-----BEGIN-----")
    }

    const writes = boat.calls.filter((c) => c.path.endsWith("/files") && c.method === "PUT")
    const envWrite = writes.find((c) => c.body.path.startsWith(".claxedo-runtime-env."))
    expect(envWrite?.body.content).toContain("export RUNTIME_SECRET='synthetic-runtime-secret'")
    expect(envWrite?.body.content).toContain("export CALLER_SECRET='synthetic-caller-secret'")
    expect(envWrite?.body.content).toContain("export PEM='-----BEGIN-----\nline2\n-----END-----'")
    const passwordWrite = writes.find((c) => c.body.path.startsWith(".claxedo-registry-password."))
    expect(passwordWrite?.body.content).toBe("synthetic-registry-pw")

    const prepare = commands.find((c) => c.includes("docker login"))
    expect(prepare).toContain(`--password-stdin < ${passwordWrite?.body.path}`)
    expect(prepare).toContain(`rm -f ${passwordWrite?.body.path}`)
    expect(commands.find((c) => c.includes("docker run -d"))).toContain("$(pwd)/.claxedo-runtime-env:/run/claxedo-runtime.env:ro")
  })

  test("a failed run reports docker's stderr with every staged secret redacted", async () => {
    const boat = fakeBoat({
      failingStderr: "docker: Error response from daemon: Conflict. env synthetic-runtime-secret login synthetic-registry-pw",
    })
    const driver = createBoatSandboxDriver({
      apiKey: "k",
      image: IMAGE,
      fetchImpl: boat.fetchImpl,
      registryAuth: { server: "registry.example.com", username: "builder", password: "synthetic-registry-pw" },
      env: () => ({ RUNTIME_SECRET: "synthetic-runtime-secret" }),
    })

    const failure = await driver.ensureHost(ensureInput()).then(
      () => { throw new Error("expected ensure to fail") },
      (err: unknown) => err as Error,
    )
    expect(failure.message.startsWith(`Boat ${ID} runtime image preparation failed (exit 125): docker: Error response from daemon: Conflict.`)).toBe(true)
    expect(failure.message).toContain(`; Boat ${ID} staged file cleanup failed (exit 125)`)
    expect(failure.message).toContain("[redacted]")
    expect(failure.message).not.toContain("synthetic-runtime-secret")
    expect(failure.message).not.toContain("synthetic-registry-pw")
  })

  test("a container start that fails and whose cleanup fails too is still the boot failure it was, with both reasons", async () => {
    const boat = fakeBoat()
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, healthIntervalMs: 0, fetchImpl: async (url, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      if (body?.command?.includes("docker run -d")) return Response.json({ ok: true, ...commandFinished({ exitCode: 1, stderr: "invalid mount" }) })
      if (body?.command?.startsWith("rm -f .claxedo-runtime-env.")) return Response.json({ ok: true, ...commandFinished({ exitCode: 1, stderr: "read-only file system" }) })
      return boat.fetchImpl(url, init)
    } })
    const failure = await driver.ensureHost(ensureInput()).then(() => undefined, (error: unknown) => error as Error)
    expect(isSandboxRuntimeBootFailure(failure)).toBe(true)
    expect(failure?.message).toBe(`Boat ${ID} container start failed (exit 1): invalid mount; Boat ${ID} staged file cleanup failed (exit 1): read-only file system`)
  })

  test("a command request outlasts its command, while other calls keep the client timeout", async () => {
    const boat = fakeBoat()
    const delayed = (match: (url: string, body: any) => boolean): BoatFetch => async (url, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      if (match(url, body)) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 80)
          init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal?.reason) })
        })
      }
      return boat.fetchImpl(url, init)
    }
    const slowRun = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, healthIntervalMs: 0, operationTimeoutMs: 20,
      fetchImpl: delayed((_url, body) => body?.command?.includes("docker run -d")) })
    expect(await slowRun.ensureHost(ensureInput())).toMatchObject({ sandboxId: ID })
    const slowRead = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, healthIntervalMs: 0, operationTimeoutMs: 20,
      fetchImpl: delayed((url) => url.endsWith(`/sandboxes/${ID}`)) })
    await expect(slowRead.ensureHost(ensureInput())).rejects.toMatchObject({ code: "transport_failed" })
  })

  test("a sandbox deleted after a failed hand-off is never re-created under its idempotency key", async () => {
    const store = createMemoryLeaseStore()
    const boat = fakeBoat()
    let fail = true
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, healthIntervalMs: 0, fetchImpl: boat.fetchImpl })
    const manager = createSandboxManager({ driver, onEgressUnenforced: () => {}, retryDelayMs: () => 0, leaseStore: { ...store,
      async recordTarget(workspaceId, epoch, target) {
        if (fail) {
          fail = false
          throw new Error("storage unavailable")
        }
        return store.recordTarget(workspaceId, epoch, target)
      } } })
    expect((await manager.ensure("ws1", { homeRegion: "eu" })).status).toBe("unavailable")
    expect((await manager.ensure("ws1", { homeRegion: "eu" })).status).toBe("ready")
    expect(boat.calls.filter((call) => call.path === "/sandboxes").map((call) => call.headers["Idempotency-Key"])).toEqual(["claxedo:ws1:1", "claxedo:ws1:2"])
    expect(boat.calls.filter((call) => call.method === "DELETE")).toHaveLength(1)
  })

  test("a timed-out container start fails the boot", async () => {
    const boat = fakeBoat()
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: async (url, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      if (body?.command?.includes("docker run -d")) return Response.json({ ok: true, ...commandFinished({ exitCode: null, timedOut: true }) })
      return boat.fetchImpl(url, init)
    } })
    await expect(driver.ensureHost(ensureInput())).rejects.toThrow(/container start timed out/)
    expect(commandsOf(boat.calls).some(isHostCommand)).toBe(false)
  })

  test("retries the health probe until the runtime answers 200", async () => {
    const boat = fakeBoat({ failHealthOnce: true })
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: boat.fetchImpl, healthIntervalMs: 0 })
    const target = await driver.ensureHost(ensureInput())
    if ("provisioning" in target) throw new Error("unexpected provisioning")
    expect(boat.healthChecks).toBeGreaterThanOrEqual(2)
  })

  test("a runtime container paused by Boat's snapshot keeps the boot waiting for its health", async () => {
    const boat = fakeBoat({ failHealthOnce: true, containerState: "paused" })
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: boat.fetchImpl, healthIntervalMs: 0 })
    const target = await driver.ensureHost(ensureInput())
    if ("provisioning" in target) throw new Error("unexpected provisioning")
    expect(boat.healthChecks).toBe(2)
  })

  test("a runtime container that exited fails the boot at the next probe, with its reason, instead of waiting out the health window", async () => {
    const boat = fakeBoat({ failHealthOnce: true, containerState: "exited" })
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, healthIntervalMs: 0, healthTimeoutMs: 60_000, fetchImpl: async (url, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      if (body?.command?.includes("docker logs")) {
        return Response.json({ ok: true, ...commandFinished({ stdout: "status=exited exit=1 oom=false\n.claxedo/start.sh exited 1: bun install failed" }) })
      }
      return boat.fetchImpl(url, init)
    } })
    const failure = await driver.ensureHost(ensureInput()).catch((error: unknown) => error as Error)
    expect(isSandboxRuntimeBootFailure(failure)).toBe(true)
    expect((failure as Error).message).toContain("the runtime container is exited; status=exited exit=1 oom=false\n.claxedo/start.sh exited 1: bun install failed")
    expect(boat.healthChecks).toBe(1)
  })

  test("a runtime that exited after printing its boot-failure line reports that line's reason, not the stack trace that filled the log tail", async () => {
    const boat = fakeBoat({ failHealthOnce: true, containerState: "exited" })
    const reason = 'The branch "lane-r2-no-such-branch" does not exist in https://github.com/octocat/Spoon-Knife'
    const frames = ["checkOut", "async prepareRuntimeRepository", "async Object.measure", "async claxedoWorkspaceRuntimeBootFromEnv", "async runWorkspaceRuntimeHost", "async file:///opt/workspace-runtime/workspace-runtime-host.mjs:82847:1"]
      .map((frame, index) => `    at ${frame} (file:///opt/workspace-runtime/workspace-runtime-host.mjs:${80772 + index * 100}:${13 + index})`)
    const logs = ["status=exited exit=1 oom=false", "[claxedo-workspace-runtime] starting", `[claxedo-workspace-runtime] workspace_runtime_boot_failed: Error: ${reason}`, ...frames].join("\n")
    expect(frames.join("\n").length).toBeGreaterThan(600)
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, healthIntervalMs: 0, fetchImpl: async (url, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      if (body?.command?.includes("docker logs")) return Response.json({ ok: true, ...commandFinished({ stdout: logs }) })
      return boat.fetchImpl(url, init)
    } })
    const failure = await driver.ensureHost(ensureInput()).catch((error: unknown) => error as Error)
    expect(isSandboxRuntimeBootFailure(failure)).toBe(true)
    expect((failure as Error).message).toBe(`Boat ${ID} runtime did not become healthy: the runtime container is exited; workspace_runtime_boot_failed: ${reason}`)
    expect(sandboxRuntimeBootFailure(`runtime_boot_failed: ${(failure as Error).message}`)).toBe(reason)
  })

  test("an unhealthy runtime reports bounded container diagnostics with staged secrets redacted", async () => {
    const boat = fakeBoat()
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, healthTimeoutMs: 0,
      env: () => ({ RUNTIME_SECRET: "synthetic-runtime-secret" }),
      fetchImpl: async (url, init) => {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
        if (body?.command?.includes("docker logs")) {
          expect(body.timeoutSeconds).toBe(10)
          expect(body.command).not.toContain("synthetic-runtime-secret")
          expect(body.command).not.toContain(".Config.Env")
          return Response.json({ ok: true, ...commandFinished({
            stdout: `status=exited exit=1 oom=false\n${"x".repeat(800)}\nStartup failed: synthetic-runtime-secret`,
          }) })
        }
        return boat.fetchImpl(url, init)
      },
    })
    const failure = await driver.ensureHost(ensureInput()).catch((error: unknown) => error as Error)
    expect(isSandboxRuntimeBootFailure(failure)).toBe(true)
    expect((failure as Error).message).toContain("Startup failed: [redacted]")
    expect((failure as Error).message).not.toContain("synthetic-runtime-secret")
    expect((failure as Error).message.length).toBeLessThan(750)
  })

  test("a failed diagnostic request preserves the health failure", async () => {
    const boat = fakeBoat()
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, healthTimeoutMs: 0,
      fetchImpl: async (url, init) => {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
        if (body?.command?.includes("docker logs")) throw new Error("transport leaked-secret")
        return boat.fetchImpl(url, init)
      },
    })
    await expect(driver.ensureHost(ensureInput())).rejects.toThrow("runtime did not become healthy: workspace runtime not ready; container diagnostics unavailable")
  })

  test("refuses an oversized acknowledgement, a redirect-capable or non-HTTPS endpoint, and never copies provider text", async () => {
    const huge = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: async () => new Response("x".repeat(5 * 1024 * 1024)) })
    await expect(huge.ensureHost(ensureInput())).rejects.toMatchObject({ code: "invalid_response" })
    let redirect: RequestRedirect | undefined
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: async (_url, init) => {
      redirect = init?.redirect
      return Response.json({ ok: false, code: "unauthorized", message: "Unauthorized key boat_secret" }, { status: 401 })
    } })
    const error = await driver.ensureHost(ensureInput()).then(
      () => { throw new Error("expected ensure to fail") },
      (cause: unknown) => cause as Error,
    )
    expect(redirect).toBe("manual")
    expect(error).toMatchObject({ code: "unauthorized", status: 401 })
    expect(error.message).not.toContain("boat_secret")
    for (const baseUrl of ["http://boat.dev/api/v1", "https://user:secret@boat.dev/api/v1", "https://boat.dev/api/v1?secret=x"]) {
      expect(() => createBoatSandboxDriver({ apiKey: "k", image: IMAGE, baseUrl })).toThrow(/HTTPS/)
    }
  })

  test.each([[401, "unauthorized", true], [403, "forbidden", true], [404, "not_found", false], [500, "internal", false]] as const)(
    "a %s from Boat is a refusal of its key only when it is 401 or 403",
    async (status, code, refused) => {
      const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: async () => Response.json({ ok: false, code, message: code }, { status }) })
      const error = await driver.ensureHost(ensureInput()).then(() => undefined, (cause: unknown) => cause)
      expect(isSandboxProviderKeyRefused(error)).toBe(refused)
    },
  )

  test.each([301, 302, 303, 307, 308])("a %s redirect is a refusal, never followed with the key", async (status) => {
    const calls: string[] = []
    const driver = createBoatSandboxDriver({ apiKey: "boat_secret", image: IMAGE, fetchImpl: async (url, init) => {
      calls.push(url)
      expect(init?.redirect).toBe("manual")
      return new Response(null, { status, headers: { Location: "https://other.example/collect" } })
    } })
    await expect(driver.ensureHost(ensureInput())).rejects.toMatchObject({ code: `http_${status}`, status })
    expect(calls).toEqual([`${API}/sandboxes`])
  })

  test("option-like image identifiers are rejected before the docker run", async () => {
    for (const bad of ["--privileged", "-v/host:/host", "img:test --network=host"]) {
      const boat = fakeBoat()
      const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: boat.fetchImpl, healthIntervalMs: 0 })
      await expect(
        driver.ensureHost(ensureInput({ bootSource: { kind: "image", image: bad } })),
      ).rejects.toThrow(/image reference/)
      expect(boat.calls.some((c) => c.path.endsWith("/commands"))).toBe(false)
    }
    const boat = fakeBoat()
    const badOptions = createBoatSandboxDriver({ apiKey: "k", image: "--network=host", fetchImpl: boat.fetchImpl })
    await expect(badOptions.ensureHost(ensureInput())).rejects.toThrow(/image reference/)
    expect(boat.calls.some((c) => c.path.endsWith("/commands"))).toBe(false)
  })

  test("rejects restricted network policy", async () => {
    const boat = fakeBoat()
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: boat.fetchImpl })
    await expect(
      driver.ensureHost(ensureInput({ net: { mode: "restricted", hosts: ["example.com"] } })),
    ).rejects.toThrow(/network policy/)
  })

  test("stop ends the runtime container with Boat's own grace and keeps it, then archives the sandbox; destroy deletes it", async () => {
    const boat = fakeBoat()
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: boat.fetchImpl })
    const target = { workspaceId: "ws1", sandboxId: ID, url: "https://x", hostId: "boat-ws1" }
    await driver.stop?.(target)
    await driver.destroy?.(target)
    expect(boat.calls.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "POST", path: `/sandboxes/${ID}/commands` },
      { method: "POST", path: `/sandboxes/${ID}/stop` },
      { method: "DELETE", path: `/sandboxes/${ID}` },
    ])
    expect(boat.calls[0].body).toEqual({
      command: "docker stop -t 30 claxedo-runtime >/dev/null 2>&1; true",
      timeoutSeconds: 60,
    })
  })

  test("resume brings an archived sandbox back under the boot deadline, re-establishes the runtime, and removes the deadline", async () => {
    const boat = fakeBoat({ states: ["archived", "provisioning", "ready"] })
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: boat.fetchImpl, healthIntervalMs: 0, provisionIntervalMs: 0 })
    const target = await driver.resumeHost?.({
      lease: sandboxLease({ workspaceId: "ws1", sandboxId: ID, hostId: "boat-ws1", url: "https://runtime.test", status: "stopped" }),
      ensure: ensureInput(),
    })
    if (!target || "provisioning" in target) throw new Error("unexpected provisioning")
    expect(target.sandboxId).toBe(ID)
    expect(boat.calls.find((c) => c.path === `/sandboxes/${ID}/resume`)?.body).toEqual({ noEnv: true, ttlSeconds: BOOT_TTL_SECONDS })
    expect(ttlUpdates(boat.calls)).toEqual([{ ttlSeconds: null }])
  })

  test("a resume Boat refuses because another boot's resume of the sandbox is under way waits for that resume and boots", async () => {
    const boat = fakeBoat({ states: ["archived", "provisioning", "ready"] })
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, healthIntervalMs: 0, provisionIntervalMs: 0, fetchImpl: async (url, init) => {
      if (url.endsWith("/resume")) return Response.json({ ok: false, code: "sandbox_resuming", message: "The sandbox is already resuming" }, { status: 409 })
      return boat.fetchImpl(url, init)
    } })
    const target = await driver.resumeHost!({
      lease: sandboxLease({ workspaceId: "ws1", sandboxId: ID, hostId: "boat-ws1", url: "https://runtime.test", status: "stopped" }),
      ensure: ensureInput(),
    })
    expect(target).toMatchObject({ sandboxId: ID, url: "https://machine-2593.on.boat.dev" })
  })

  test("a sandbox that still runs is booted again without a resume, and one still archiving is polled", async () => {
    const running = fakeBoat({ states: ["idle"] })
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: running.fetchImpl, healthIntervalMs: 0, provisionIntervalMs: 0 })
    const lease = sandboxLease({ workspaceId: "ws1", sandboxId: ID, hostId: "boat-ws1", status: "unavailable", lastError: "Boat GET /sandboxes/bx_23456789 was rejected (http_500)" })
    const target = await driver.resumeHost?.({ lease, ensure: ensureInput() })
    if (!target || "provisioning" in target) throw new Error("unexpected provisioning")
    expect(running.calls.filter((c) => c.path.endsWith("/resume"))).toHaveLength(0)
    expect(commandsOf(running.calls).some((command) => command.includes("docker run -d"))).toBe(true)

    const archiving = fakeBoat({ states: ["archiving"] })
    const polled = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: archiving.fetchImpl, provisionIntervalMs: 250 })
    expect(await polled.resumeHost?.({ lease, ensure: ensureInput() })).toEqual({ provisioning: true, retryAfterMs: 250 })
    expect(archiving.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /sandboxes/${ID}`])
  })

  test("a boot whose deadline Boat refuses to remove fails before the runtime is published", async () => {
    const boat = fakeBoat()
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, healthIntervalMs: 0, fetchImpl: async (url, init) => {
      if (init?.method === "PATCH") return Response.json({ ok: false, code: "trial_auto_stop_required", message: "trial" }, { status: 403 })
      return boat.fetchImpl(url, init)
    } })
    await expect(driver.ensureHost(ensureInput())).rejects.toThrow("trial_auto_stop_required")
    expect(commandsOf(boat.calls).some((command) => command.startsWith("host url"))).toBe(false)
  })

  test("an answer of a type the call does not expect names the call and the type Boat sent", async () => {
    const boat = fakeBoat()
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, healthIntervalMs: 0, fetchImpl: async (url, init) => {
      if (init?.method === "PATCH") return Response.json({ ok: true, type: "sandbox.renamed", sandbox: sandboxRecord("ready") })
      return boat.fetchImpl(url, init)
    } })
    await expect(driver.ensureHost(ensureInput())).rejects.toMatchObject({
      code: "invalid_response",
      message: `Boat PATCH /sandboxes/${ID} answered "sandbox.renamed", expected sandbox.updated or sandbox.info`,
    })
  })

  test("a boot that fails stops the sandbox, the lease keeps it, and the retry resumes it under the one create", async () => {
    const store = createMemoryLeaseStore()
    const boat = fakeBoat({ failHealthOnce: true, containerState: "exited" })
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: boat.fetchImpl, healthIntervalMs: 0, provisionIntervalMs: 0 })
    const manager = createSandboxManager({ leaseStore: store, driver, retryDelayMs: () => 0, onEgressUnenforced: () => {} })

    const failed = await manager.ensure("ws1", { homeRegion: "eu" })
    expect(failed.status === "unavailable" ? sandboxRuntimeBootFailure(failed.error) : undefined).toContain("the runtime container is exited")
    expect(boat.calls.map((c) => `${c.method} ${c.path}`)).toContain(`POST /sandboxes/${ID}/stop`)
    await expect(store.get("ws1")).resolves.toMatchObject({ status: "unavailable", epoch: 1, sandboxId: ID, retryCount: 1 })

    boat.options.containerState = "running"
    expect((await manager.ensure("ws1", { homeRegion: "eu" })).status).toBe("ready")
    await expect(store.get("ws1")).resolves.toMatchObject({ status: "ready", epoch: 2, sandboxId: ID, retryCount: 0 })
    expect(boat.calls.filter((c) => c.path === "/sandboxes" && c.method === "POST")).toHaveLength(1)
    expect(boat.calls.find((c) => c.path.endsWith("/resume"))?.body).toEqual({ noEnv: true, ttlSeconds: BOOT_TTL_SECONDS })
    expect(ttlUpdates(boat.calls)).toEqual([{ ttlSeconds: null }])
  })

  test("a stopped sandbox is resumed onto the machine the lease names now, and onto the one it has when the lease names none", async () => {
    const lease = (machineClass?: "small" | "default" | "large") => sandboxLease({ workspaceId: "ws1", sandboxId: ID, hostId: "boat-ws1", status: "stopped", machineClass })
    const resized = fakeBoat({ states: ["archived", "ready"] })
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: resized.fetchImpl, healthIntervalMs: 0, provisionIntervalMs: 0 })
    await driver.resumeHost!({ lease: lease("small"), ensure: ensureInput({ machineClass: "small" }) })
    expect(resized.calls.find((c) => c.path.endsWith("/resume"))?.body).toEqual({ noEnv: true, ttlSeconds: BOOT_TTL_SECONDS, type: "small" })

    const kept = fakeBoat({ states: ["archived", "ready"] })
    const unsized = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: kept.fetchImpl, healthIntervalMs: 0, provisionIntervalMs: 0 })
    await unsized.resumeHost!({ lease: lease(), ensure: ensureInput() })
    expect(kept.calls.find((c) => c.path.endsWith("/resume"))?.body).toEqual({ noEnv: true, ttlSeconds: BOOT_TTL_SECONDS })
  })

  test.each([
    ["deleted", "not_found", 404],
    ["expired", "snapshot_data_expired", 409],
  ])("a sandbox Boat no longer has (%s) is reported gone from a resume, a stop and an inspect, with no replacement created", async (_kind, code, status) => {
    const boat = fakeBoat()
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, provisionIntervalMs: 0, fetchImpl: async (url, init) => {
      if (url.endsWith(`/sandboxes/${ID}`) && init?.method === "GET" || url.endsWith("/stop") || url.endsWith("/resume")) {
        return Response.json({ ok: false, code, message: "gone" }, { status })
      }
      return boat.fetchImpl(url, init)
    } })
    const lease = sandboxLease({ workspaceId: "ws1", sandboxId: ID, hostId: "boat-ws1", url: "https://runtime.test", status: "stopped" })
    const resumed = await driver.resumeHost!({ lease, ensure: ensureInput() }).catch((error: unknown) => error)
    expect(isSandboxHostGone(resumed)).toBe(true)
    expect((resumed as Error).message).toBe(`Boat GET /sandboxes/${ID} was rejected (${code})`)

    const stopped = await driver.stop!({ workspaceId: "ws1", sandboxId: ID, url: "https://x", hostId: "boat-ws1" }).catch((error: unknown) => error)
    expect(isSandboxHostGone(stopped)).toBe(true)
    expect(await driver.inspect!({ workspaceId: "ws1", sandboxId: ID, url: "https://x", hostId: "boat-ws1" })).toBe("gone")
    expect(boat.calls.filter((call) => call.path === "/sandboxes" && call.method === "POST")).toHaveLength(0)
  })

  test.each([
    ["ready", "serving"],
    ["running", "serving"],
    ["provisioning", "serving"],
    ["archiving", "stopped"],
    ["archived", "stopped"],
    ["error", "stopped"],
  ] as const)("a sandbox Boat holds in state %s inspects as %s", async (state, expected) => {
    const boat = fakeBoat({ states: [state] })
    const target = { workspaceId: "ws1", sandboxId: ID, url: "https://x", hostId: "boat-ws1" }
    expect(await createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: boat.fetchImpl }).inspect!(target)).toBe(expected)
  })

  test("a refusal of the inspect read is no answer about the sandbox", async () => {
    const target = { workspaceId: "ws1", sandboxId: ID, url: "https://x", hostId: "boat-ws1" }
    const refused = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: async () => Response.json({ ok: false, code: "unauthorized", message: "Unauthorized" }, { status: 401 }) })
    await expect(refused.inspect!(target)).rejects.toThrow("unauthorized")
  })

  test("a provider refusal that is not about the sandbox's existence is not a host gone", async () => {
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: async () =>
      Response.json({ ok: false, code: "unauthorized", message: "Unauthorized" }, { status: 401 }) })
    const failure = await driver.stop!({ workspaceId: "ws1", sandboxId: ID, url: "https://x", hostId: "boat-ws1" }).catch((error: unknown) => error)
    expect(isSandboxHostGone(failure)).toBe(false)
    expect((failure as Error).message).toContain("unauthorized")
  })

  test("a failed boot keeps the branch and repository readable while every secret stays redacted", async () => {
    const boat = fakeBoat({
      failingStderr: "fatal: couldn't find remote ref refs/heads/lane-b-no-such-branch at https://github.com/octocat/git-consortium token synthetic-caller-secret",
    })
    const driver = createBoatSandboxDriver({ apiKey: "k", image: IMAGE, fetchImpl: boat.fetchImpl, env: () => ({ RUNTIME_SECRET: "synthetic-runtime-secret" }) })
    const failure = await driver.ensureHost(ensureInput({
      source: { kind: "git", repoUrl: "https://github.com/octocat/git-consortium", branch: "lane-b-no-such-branch" },
      env: { CALLER_SECRET: "synthetic-caller-secret" },
    })).then(
      () => { throw new Error("expected the boot to fail") },
      (error: unknown) => error as Error,
    )
    expect(failure.message).toContain("refs/heads/lane-b-no-such-branch at https://github.com/octocat/git-consortium")
    expect(failure.message).toContain("token [redacted]")
    expect(failure.message).not.toContain("synthetic-caller-secret")
  })
})
