import type { ContainerExecOptions, ContainerStart, WorkspaceContainer } from "../container-api"
import { TRUST_INTERCEPT_CA } from "../container-trust"
import { RUNTIME_DIGEST_SCRIPT } from "../runtime-integrity"
import { LAUNCH_RUNTIME, MEMORY_RUNTIME_ROOT, RUNTIME_STATUS, STOP_RUNTIME } from "../runtime-process"

/** The digest of the runtime files the fake image carries, as the Worker's build identity names it. */
export const IMAGE_RUNTIME_DIGEST = "d".repeat(64)
export const IMAGE_ENVIRON = "PATH=/root/.local/bin:/usr/local/bin:/usr/bin\0AMP_SKIP_UPDATE_CHECK=1\0CLOUDFLARE_PLACEMENT_ID=placement-1\0"

export type FakeLaunch = {
  dir: string
  command: string
  env: Record<string, string>
  cwd?: string
  state: "starting" | "running" | "exited"
  exitCode?: number
  stdout: string
  stderr: string
}

export type LaunchOutcome = { state: "running" } | { state: "starting" } | { state: "exited"; exitCode: number; stderr?: string }

const encoder = new TextEncoder()

function output(stdout = "", exitCode = 0, stderr = "") {
  const answer = { stdout: encoder.encode(stdout).buffer, stderr: encoder.encode(stderr).buffer, exitCode }
  return { exitCode: Promise.resolve(exitCode), output: async () => answer }
}

/**
 * `ctx.container` under the `durable_object` scheduling policy, as far as this
 * Worker drives it: the scripts it execs are answered by what they do, so the
 * tests read the container's state rather than the calls that changed it.
 */
export function fakeContainer(options: { missingSnapshots?: string[]; trustExit?: number; memoryRootExit?: number } = {}) {
  const missing = new Set(options.missingSnapshots ?? [])
  const snapshotDigests = new Map<string, string>()
  const state = {
    running: false,
    /** What the runtime files hash to in the running container; a test changes it to stand for an agent editing them. */
    runtimeDigest: IMAGE_RUNTIME_DIGEST,
    starts: [] as ContainerStart[],
    intercepted: [] as string[],
    inactivityTimeouts: [] as number[],
    destroys: 0,
    snapshots: [] as string[],
    stops: [] as string[],
    launches: new Map<string, FakeLaunch>(),
    proxied: [] as string[],
    healthy: (_launch: FakeLaunch | undefined) => true,
    onLaunch: (_launch: FakeLaunch): LaunchOutcome => ({ state: "running" }),
    failure: undefined as Error | undefined,
  }
  let fail: ((error: Error) => void) | undefined

  function current() {
    return [...state.launches.values()].find((launch) => launch.state !== "exited") ?? [...state.launches.values()].at(-1)
  }

  function status(dir: string) {
    const launch = state.launches.get(dir)
    if (!launch) return "missing"
    if (launch.state === "exited") return `exited ${launch.exitCode}`
    return launch.state === "starting" ? "starting" : "running 41"
  }

  const container: WorkspaceContainer = {
    get running() {
      return state.running
    },
    images: { runtime: "registry.cloudflare.com/acct/claxedo-runtime@sha256:abc" },
    start(start) {
      if (state.running) throw new Error("Container is already running")
      state.starts.push(start)
      state.launches.clear()
      if ("containerSnapshot" in start && missing.has(start.containerSnapshot.id)) {
        state.failure = new Error(`Snapshot "${start.containerSnapshot.id}" was not found.`)
        return
      }
      state.failure = undefined
      state.running = true
      state.runtimeDigest = "containerSnapshot" in start ? snapshotDigests.get(start.containerSnapshot.id) ?? IMAGE_RUNTIME_DIGEST : IMAGE_RUNTIME_DIGEST
    },
    monitor() {
      if (state.failure) return Promise.reject(state.failure)
      return new Promise<void>((_, reject) => {
        fail = reject
      })
    },
    async destroy() {
      state.destroys += 1
      state.running = false
      state.launches.clear()
      fail?.(new Error("destroyed"))
    },
    async exec(argv: string[], execOptions: ContainerExecOptions = {}) {
      if (!state.running) throw new Error("Container is not running")
      const [program, flag, script, , dir = "", command = ""] = argv
      if (program === "true") return output()
      if (program === "cat" && flag === "/proc/1/environ") return output(IMAGE_ENVIRON)
      if (program === "mkdir") return output()
      if (program === "tail") {
        const path = argv[3] ?? ""
        const launch = state.launches.get(path.slice(0, path.lastIndexOf("/")))
        return output(path.endsWith("stderr.log") ? launch?.stderr : launch?.stdout)
      }
      if (program !== "sh" || flag !== "-c") throw new Error(`unexpected exec ${argv.join(" ")}`)
      if (script === TRUST_INTERCEPT_CA) return output("", options.trustExit ?? 0)
      if (script === MEMORY_RUNTIME_ROOT) return output("", options.memoryRootExit ?? 0)
      if (script === RUNTIME_DIGEST_SCRIPT) return output(`${state.runtimeDigest}\n`)
      if (script === RUNTIME_STATUS) return output(`${status(dir)}\n`)
      if (script === STOP_RUNTIME) {
        state.stops.push(dir)
        state.launches.delete(dir)
        return output()
      }
      if (script === LAUNCH_RUNTIME) {
        const launch: FakeLaunch = { dir, command, env: execOptions.env ?? {}, cwd: execOptions.cwd, state: "starting", stdout: "", stderr: "" }
        const outcome = state.onLaunch(launch)
        launch.state = outcome.state
        if (outcome.state === "exited") {
          launch.exitCode = outcome.exitCode
          launch.stderr = outcome.stderr ?? ""
        }
        state.launches.set(dir, launch)
        return output()
      }
      throw new Error(`unexpected script ${script?.slice(0, 40)}`)
    },
    getTcpPort(port: number) {
      return {
        async fetch(input: RequestInfo | URL) {
          const url = new URL(input instanceof Request ? input.url : String(input))
          if (url.pathname === "/global/health") {
            const launch = current()
            if (!launch || launch.state !== "running" || !state.healthy(launch)) throw new Error("connection refused")
            return new Response("ok")
          }
          state.proxied.push(`${port}${url.pathname}`)
          return new Response(`proxied ${url.pathname}`)
        },
      }
    },
    async setInactivityTimeout(ms: number) {
      state.inactivityTimeouts.push(ms)
    },
    async interceptOutboundHttps(host: string) {
      state.intercepted.push(host)
    },
    async snapshotContainer() {
      if (!state.running) throw new Error("Container is not running")
      const id = `snap-${state.snapshots.length + 1}`
      state.snapshots.push(id)
      snapshotDigests.set(id, state.runtimeDigest)
      return { id, size: 4_096 }
    },
  }
  return { container, state }
}

/** Durable Object storage as this Worker uses it, in memory. */
export function fakeStorage() {
  const values = new Map<string, unknown>()
  let alarm: number | null = null
  return {
    values,
    alarm: () => alarm,
    async get<T>(key: string) {
      return structuredClone(values.get(key)) as T | undefined
    },
    async put(key: string, value: unknown) {
      values.set(key, structuredClone(value))
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key)
      return true
    },
    async deleteAll() {
      values.clear()
    },
    async list<T>({ prefix }: { prefix: string }) {
      return new Map([...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value) as T]))
    },
    async setAlarm(at: number) {
      alarm = at
    },
    async deleteAlarm() {
      alarm = null
    },
  }
}
