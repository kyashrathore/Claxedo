import { RUNTIME_PREPARATION_DEADLINE_MS, WORKSPACE_RUNTIME_BOOT_FAILED, WORKSPACE_RUNTIME_OPERATOR_LOG } from "../../../../src/hosts/workspace-runtime/boot-contract"
import { bounded, run, type WorkspaceContainer } from "./container-api"
import { INTERCEPT_TRUST_ENV } from "./container-trust"
import { safeRuntimeLog } from "./runtime-log"

/**
 * Where each launch keeps its pid, exit code and unredacted output. It is
 * memory, mounted over when `/run` is not, so a snapshot never carries a
 * runtime's logs and a restored container finds no launch of its source.
 */
export const RUNTIME_ROOT = "/run/claxedo-runtime"

export const MEMORY_RUNTIME_ROOT = `root=$1
mkdir -p "$root" || exit 1
[ "$(stat -f -c %T "$root")" = tmpfs ] || mount -t tmpfs -o mode=0700 tmpfs "$root" || exit 1
[ "$(stat -f -c %T "$root")" = tmpfs ]`
const RUNTIME_CWD = "/workspace"
const RUNTIME_READY_TIMEOUT_MS = 30_000
const RUNTIME_READY_POLL_MS = 500
const RUNTIME_HEALTH_ATTEMPT_MS = 2_000
const RUNTIME_WEDGED_AFTER_MS = RUNTIME_PREPARATION_DEADLINE_MS + 5 * 60_000
const LOG_TAIL_BYTES = "65536"

/**
 * The runtime runs in its own process group so a stop also ends the git and
 * harness processes it started. The exit code is renamed into place, so a
 * reader never sees a partial file.
 */
export const LAUNCH_RUNTIME = `dir=$1; command=$2
setsid sh -c 'echo "$$" >"$0/pid"; exec sh -c "$1"' "$dir" "$command" >"$dir/stdout.log" 2>"$dir/stderr.log"
echo "$?" >"$dir/exit-code.tmp" && mv "$dir/exit-code.tmp" "$dir/exit-code"`

export const RUNTIME_STATUS = `dir=$1
if [ ! -d "$dir" ]; then echo missing
elif [ -e "$dir/exit-code" ]; then echo "exited $(cat "$dir/exit-code")"
elif ! read -r pid 2>/dev/null <"$dir/pid"; then echo starting
elif kill -0 "$pid" 2>/dev/null; then echo "running $pid"
elif [ -e "$dir/exit-code" ]; then echo "exited $(cat "$dir/exit-code")"
else echo lost
fi`

/** SIGTERM to the group, SIGKILL after 5 seconds, then the launch is forgotten. */
export const STOP_RUNTIME = `dir=$1
if [ ! -e "$dir/exit-code" ] && read -r pid 2>/dev/null <"$dir/pid" && kill -0 "$pid" 2>/dev/null; then
  kill -s TERM -- "-$pid" 2>/dev/null
  i=0
  while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
  kill -s KILL -- "-$pid" 2>/dev/null
fi
rm -rf "$dir"`

export type RuntimeLaunch = { id: string; launchedAt: number; ready: boolean }

export type RuntimeStatus =
  | { state: "missing" | "starting" | "lost" }
  | { state: "running"; pid: number }
  | { state: "exited"; exitCode: number }

export type RuntimeEnsure =
  | { state: "ready" }
  | { state: "preparing" }
  | { state: "exited"; reason: string }

/** Where the one launch this sandbox runs is recorded; it outlives a restarted Durable Object, not a restarted container. */
export type RuntimeLaunches = {
  get(): Promise<RuntimeLaunch | undefined>
  put(launch: RuntimeLaunch): Promise<void>
  delete(): Promise<void>
}

export type RuntimeHost = {
  container: WorkspaceContainer
  launches: RuntimeLaunches
  /** The image's own environment, which `exec` does not pass on; recorded outside the container, never read back from it. */
  imageEnv: Record<string, string>
  /** Runs before every launch, which hands the runtime the boot env; it throws to refuse the launch. */
  beforeLaunch?: () => Promise<void>
  now?: () => number
  newId?: () => string
  pause?: (ms: number) => Promise<void>
}

type Existing = { launch: RuntimeLaunch; status: RuntimeStatus }

function launchDir(launch: RuntimeLaunch) {
  return `${RUNTIME_ROOT}/${launch.id}`
}

export function runtimeLogPath(launch: RuntimeLaunch, stream: "stdout" | "stderr" | "operator") {
  return `${launchDir(launch)}/${stream}.log`
}

function live(status: RuntimeStatus) {
  return status.state === "starting" || status.state === "running"
}

function parseStatus(line: string): RuntimeStatus {
  const [state, value] = line.trim().split(" ")
  if (state === "running") return { state, pid: Number(value) }
  if (state === "exited") return { state, exitCode: Number(value) }
  if (state === "missing" || state === "starting" || state === "lost") return { state }
  throw new Error(`Unreadable workspace-runtime status: ${line.trim().slice(0, 100)}`)
}

async function runtimeStatus(container: WorkspaceContainer, launch: RuntimeLaunch) {
  const status = await bounded(run(container, ["sh", "-c", RUNTIME_STATUS, "status", launchDir(launch)]), "workspace-runtime status")
  return parseStatus(status.stdout)
}

async function currentRuntime(host: RuntimeHost): Promise<Existing | undefined> {
  const launch = await host.launches.get()
  if (!launch) return undefined
  const status = await runtimeStatus(host.container, launch)
  if (status.state !== "missing") return { launch, status }
  await host.launches.delete()
  return undefined
}

async function stopRuntime(host: RuntimeHost, launch: RuntimeLaunch) {
  await bounded(run(host.container, ["sh", "-c", STOP_RUNTIME, "stop", launchDir(launch)]), "workspace-runtime stop")
  await host.launches.delete()
}

async function launchRuntime(host: RuntimeHost, command: string, env: Record<string, string>) {
  await host.beforeLaunch?.()
  const launch: RuntimeLaunch = { id: host.newId?.() ?? crypto.randomUUID(), launchedAt: (host.now ?? Date.now)(), ready: false }
  const dir = launchDir(launch)
  const created = await bounded(run(host.container, ["mkdir", "-p", dir]), "workspace-runtime launch directory")
  if (created.exitCode !== 0) throw new Error(`The workspace-runtime launch directory could not be created: ${created.stderr.trim().slice(0, 200)}`)
  const processEnv = { ...host.imageEnv, ...INTERCEPT_TRUST_ENV, ...env, [WORKSPACE_RUNTIME_OPERATOR_LOG]: runtimeLogPath(launch, "operator") }
  await bounded(host.container.exec(["sh", "-c", LAUNCH_RUNTIME, "launch", dir, command], {
    env: processEnv,
    cwd: RUNTIME_CWD,
    stdout: "ignore",
    stderr: "ignore",
  }), "workspace-runtime process start")
  await host.launches.put(launch)
  return launch
}

async function healthAnswered(container: WorkspaceContainer, port: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RUNTIME_HEALTH_ATTEMPT_MS)
  try {
    const response = await container.getTcpPort(port).fetch("http://runtime/global/health", { signal: controller.signal })
    await response.body?.cancel()
    return response.status >= 200 && response.status < 400
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** Polls the runtime's health until it answers, its process ends, or `timeoutMs` passes. */
async function runtimeReady(host: RuntimeHost, launch: RuntimeLaunch, port: number, timeoutMs: number) {
  const now = host.now ?? Date.now
  const pause = host.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadline = now() + timeoutMs
  for (;;) {
    if (await healthAnswered(host.container, port)) return true
    if (now() >= deadline || !live(await runtimeStatus(host.container, launch))) return false
    await pause(RUNTIME_READY_POLL_MS)
  }
}

const BOOT_FAILURE_LINE = `${WORKSPACE_RUNTIME_BOOT_FAILED}: `

function bootFailure(stderr: string) {
  const at = stderr.lastIndexOf(BOOT_FAILURE_LINE)
  if (at < 0) return undefined
  const [failure = ""] = stderr.slice(at + BOOT_FAILURE_LINE.length).split(/\n\s+at /)
  return safeRuntimeLog(failure.trim().replace(/^Error: /, "")).slice(0, 1_000) || undefined
}

async function launchLog(container: WorkspaceContainer, launch: RuntimeLaunch, stream: "stdout" | "stderr") {
  const tail = await bounded(run(container, ["tail", "-c", LOG_TAIL_BYTES, runtimeLogPath(launch, stream)]), "workspace-runtime log read")
  return tail.stdout
}

/** The exited runtime's own account of its failed boot, cleared away so the next ensure starts a fresh one. */
async function exitReason(host: RuntimeHost, launch: RuntimeLaunch, status: RuntimeStatus) {
  const [stdout, stderr] = await Promise.all([
    launchLog(host.container, launch, "stdout").catch(() => ""),
    launchLog(host.container, launch, "stderr").catch(() => ""),
  ])
  console.error("workspace-runtime exited before it was ready", { status, stdout: safeRuntimeLog(stdout), stderr: safeRuntimeLog(stderr) })
  await stopRuntime(host, launch)
  const ended = status.state === "exited" ? `exit code ${status.exitCode}` : status.state
  return bootFailure(stderr) ?? `The workspace runtime process ended (${ended}) before it was ready`
}

async function settledRuntime(host: RuntimeHost, launch: RuntimeLaunch, port: number): Promise<RuntimeEnsure> {
  if (await runtimeReady(host, launch, port, RUNTIME_READY_TIMEOUT_MS)) {
    if (!launch.ready) await host.launches.put({ ...launch, ready: true })
    return { state: "ready" }
  }
  const status = await runtimeStatus(host.container, launch)
  if (live(status)) return { state: "preparing" }
  return { state: "exited", reason: await exitReason(host, launch, status) }
}

/**
 * What an existing runtime is, when it is to be kept: a live runtime that has
 * answered ready is never replaced for one slow health check, and one that
 * never has is still preparing its repository until it is wedged. A runtime
 * that exited before it was ever ready failed its boot; its reason is the
 * answer, because starting it again would rerun the same boot on every poll.
 */
async function keptRuntime(host: RuntimeHost, existing: Existing, port: number): Promise<RuntimeEnsure | undefined> {
  const { launch, status } = existing
  if (!live(status)) {
    if (launch.ready) return undefined
    return { state: "exited", reason: await exitReason(host, launch, status) }
  }
  const settled = await settledRuntime(host, launch, port)
  if (settled.state !== "preparing" || launch.ready) return settled
  return (host.now ?? Date.now)() - launch.launchedAt < RUNTIME_WEDGED_AFTER_MS ? settled : undefined
}

/** `reuseRunning: false` is how a caller says the boot env changed: a running process keeps the environment it was spawned with. */
export async function ensureRuntimeProcess(
  host: RuntimeHost,
  command: string,
  env: Record<string, string>,
  port: number,
  options: { reuseRunning: boolean },
): Promise<RuntimeEnsure> {
  const existing = await currentRuntime(host)
  if (existing) {
    const kept = options.reuseRunning ? await keptRuntime(host, existing, port) : undefined
    if (kept) return kept
    await stopRuntime(host, existing.launch)
  }
  return await settledRuntime(host, await launchRuntime(host, command, env), port)
}

/** Whether the runtime this sandbox launched answers its health check now. */
export async function runtimeServing(host: RuntimeHost, port: number) {
  const existing = await currentRuntime(host)
  return Boolean(existing && live(existing.status) && await healthAnswered(host.container, port))
}
