/**
 * Drives the sandbox Worker's `WorkspaceSandbox` in local workerd against
 * local Docker: a workspace saved under runtime 0.5.2 is restored after a
 * deploy whose image carries 0.6.0 and whose control plane serves nothing
 * below it. Run under Node (`node --import tsx carry-local/run.mts`): Miniflare's
 * control channel hangs on Bun once several instances are disposed.
 */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { build } from "esbuild"
import { Miniflare } from "miniflare"
import { RUNTIME_DIGEST_SCRIPT, RUNTIME_DIR, RUNTIME_ENTRY } from "../src/runtime-integrity"
import { asWorkerRecord } from "../src/worker-json"
import { RIG_PORT } from "./rig"

const SOCKET = `unix:${process.env.DOCKER_SOCKET ?? path.join(os.homedir(), ".docker/run/docker.sock")}`
/** The egress sidecar local workerd starts beside each container; Miniflare 4.20260730 defaults to it, and nothing pulls it but Wrangler. */
const EGRESS_SIDECAR = "cloudflare/proxy-everything:3cb1195@sha256:0ef6716c52430096900b150d84a3302057d6cd2319dae7987128c85d0733e3c8"
const OLD = { version: "0.5.2", image: "claxedo-carry-rig:0.5.2" }
const NEW = { version: "0.6.0", image: "claxedo-carry-rig:0.6.0" }

const snapshots: string[] = []
const work = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-carry-"))
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim()

function rigImage(release: typeof OLD) {
  const context = path.join(work, release.version)
  fs.mkdirSync(path.join(context, "runtime"), { recursive: true })
  fs.writeFileSync(path.join(context, "runtime/workspace-runtime-version"), `${release.version}\n`)
  fs.writeFileSync(path.join(context, "runtime/workspace-runtime-host.mjs"), [
    "#!/usr/bin/env node",
    'import http from "node:http"',
    'import fs from "node:fs"',
    'const version = fs.readFileSync(new URL("./workspace-runtime-version", import.meta.url), "utf8").trim()',
    `http.createServer((_, response) => response.end(version)).listen(${RIG_PORT}, "0.0.0.0")`,
  ].join("\n"))
  fs.writeFileSync(path.join(context, "Dockerfile"), [
    "FROM node:24.21.0-trixie-slim",
    "RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates procps tini util-linux && rm -rf /var/lib/apt/lists/*",
    "RUN install -d -m 0700 /home/claxedo",
    `COPY runtime/ ${RUNTIME_DIR}/`,
    `RUN chmod 0755 ${RUNTIME_DIR}/workspace-runtime-host.mjs && ln -sf ${RUNTIME_DIR}/workspace-runtime-host.mjs ${RUNTIME_ENTRY}`,
    "WORKDIR /workspace",
  ].join("\n"))
  docker("build", "-q", "-t", release.image, context)
  const digest = docker("run", "--rm", "--entrypoint", "sh", release.image, "-c", RUNTIME_DIGEST_SCRIPT, "digest", RUNTIME_DIR, RUNTIME_ENTRY)
  return { RUNTIME_BUILD_ID: `rig-${release.version}`, RUNTIME_VERSION: release.version, RUNTIME_DIGEST: digest, RIG_IMAGE: release.image }
}

async function worker() {
  const bundle = await build({
    entryPoints: [path.join(import.meta.dirname, "entry.ts")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    external: ["cloudflare:workers"],
    write: false,
  })
  return bundle.outputFiles[0].text
}

/** One deploy: the Worker with this release's image and build identity, over the objects' storage every deploy shares. */
async function deploy(script: string, build: ReturnType<typeof rigImage>) {
  const miniflare = new Miniflare({
    modules: true,
    script,
    compatibilityDate: "2026-08-06",
    durableObjects: { WORKSPACE_SANDBOX: { className: "RigSandbox", useSQLite: true, container: { imageName: build.RIG_IMAGE } } },
    durableObjectsPersist: path.join(work, "objects"),
    containerEngine: { localDocker: { socketPath: SOCKET, containerEgressInterceptorImage: EGRESS_SIDECAR } },
    bindings: { ...build, API_TOKEN: "rig", CONTROL_PLANE_URL: "http://control.invalid", IDLE_STOP_TOKEN: "rig" },
  })
  async function call(route: string, body: Record<string, unknown> = {}) {
    const response = await miniflare.dispatchFetch(`http://rig.test${route}`, { method: "POST", body: JSON.stringify(body) })
    const answer = asWorkerRecord(await response.json()) ?? {}
    if (!response.ok) throw new Error(`${route}: ${String(answer.error)}`)
    return answer
  }
  async function shell(script: string) {
    const output = await call("/shell", { script })
    if (output.exitCode !== 0) throw new Error(`${script}: ${String(output.stderr)}`)
    return String(output.stdout).trim()
  }
  const ensure = (restore?: string, minimumRuntimeVersion?: string) => call("/ensure", { restore, minimumRuntimeVersion })
  const stop = () => call("/stop")
  async function save() {
    const { snapshotId } = await call("/snapshot")
    if (typeof snapshotId !== "string") throw new Error("The snapshot answered no id")
    snapshots.push(snapshotId)
    await stop()
    return snapshotId
  }
  return { miniflare, ensure, shell, save, stop }
}

function expectEqual(actual: unknown, expected: unknown, what: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  console.log(`ok  ${what}`)
}

const FILES = `printf '%s|%s|%s|%s|%s' "$(cat /workspace/src/edit.ts)" "$(cat /home/claxedo/.workspace-runtime/store.db)" "$(stat -c %u:%g /workspace/src/edit.ts)" "$(cat /usr/local/lib/rig-global.txt 2>/dev/null || echo absent)" "$(cat ${RUNTIME_DIR}/workspace-runtime-version)"`
const SERVED = `node -e 'fetch("http://127.0.0.1:${RIG_PORT}").then((r) => r.text()).then((t) => process.stdout.write(t))'`

const volumesBefore = new Set(docker("volume", "ls", "-q", "--filter", "name=workerd-snap-").split("\n"))
try {
  docker("pull", "-q", EGRESS_SIDECAR)
  const script = await worker()
  const oldBuild = rigImage(OLD)
  const newBuild = rigImage(NEW)

  const old = await deploy(script, oldBuild)
  expectEqual(await old.ensure(), { state: "ready" }, "runtime 0.5.2 starts from its image")
  await old.shell("mkdir -p /workspace/src /home/claxedo/.workspace-runtime && echo edit > /workspace/src/edit.ts && chown 1000:1000 /workspace/src/edit.ts && echo sessions > /home/claxedo/.workspace-runtime/store.db && echo global > /usr/local/lib/rig-global.txt")
  const saved = await old.save()
  await old.miniflare.dispose()

  const current = await deploy(script, newBuild)
  expectEqual(await current.ensure(saved, OLD.version), { state: "ready" }, "a checkpoint at the minimum restores whole")
  expectEqual(await current.shell(FILES), "edit|sessions|1000:1000|global|0.5.2", "the whole restore keeps system files and its own runtime")
  await current.stop()

  expectEqual(await current.ensure(saved, NEW.version), { state: "ready" }, "a checkpoint below the minimum is carried into the current image")
  expectEqual(await current.shell(FILES), "edit|sessions|1000:1000|absent|0.6.0", "the carry keeps the repository and HOME, owners included, and drops system files")
  expectEqual(await current.shell(SERVED), NEW.version, "the runtime serving is the current one")
  const carried = await current.save()

  expectEqual(await current.ensure(carried, NEW.version), { state: "ready" }, "the carried workspace's own checkpoint restores")
  expectEqual(await current.shell(FILES), "edit|sessions|1000:1000|absent|0.6.0", "the carried files are in the snapshot's filesystem, not only a mount")
  await current.stop()
  await current.miniflare.dispose()
  console.log("carry-local: every check passed")
} finally {
  for (const id of snapshots) execFileSync("docker", ["rmi", "-f", `workerd-container-snap-${id}`], { stdio: "ignore" })
  const created = docker("volume", "ls", "-q", "--filter", "name=workerd-snap-").split("\n").filter((name) => name && !volumesBefore.has(name))
  if (created.length) execFileSync("docker", ["volume", "rm", "-f", ...created], { stdio: "ignore" })
  fs.rmSync(work, { recursive: true, force: true })
}
