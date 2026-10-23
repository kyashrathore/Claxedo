import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHostRuntimeListener, type HostRuntimeListener } from "@claxedo/host-serving/runtime"
import { setHostServing, stopHostServing, hostServingState } from "@claxedo/host-serving/serving"
import type { ConnectDeps } from "../commands/connect"
import { desktopDaemonDiscoveryFiles, desktopDaemonState } from "./desktop-daemon"
import { createFakeConnectControlPlane, type FakeControlPlane } from "./fake-control-plane.test-support"
import type { HostDeps } from "./host"
import { defaultPairingDeps } from "./pair"
import { connectPaths, connectStateStore } from "./paths"
import { relayStub } from "./relay-stub.test-support"
import type { ServiceDeps } from "./service"

export type Harness = {
  home: string
  root: string
  cp: FakeControlPlane
  relay: ReturnType<typeof relayStub>
  lines: string[]
  tick: () => void
  stop: () => void
  listener: () => HostRuntimeListener | undefined
  deps: ConnectDeps
  serviceCalls: string[]
}

/** A Linux box whose user manager is up: lingering on, a runtime dir, `systemctl --user` answering. */
export function serviceDeps(home: string, calls: string[]): ServiceDeps {
  return {
    platform: "linux",
    homedir: home,
    username: "svc",
    command: ["/usr/bin/node", "/opt/claxedo/index.mjs"],
    claxedoHome: home,
    env: { XDG_RUNTIME_DIR: "/run/user/1000" },
    run: async (file, args) => {
      calls.push([file, ...args].join(" "))
      if (file === "loginctl") return { code: 0, stdout: "yes\n" }
      if (args.includes("is-system-running")) return { code: 0, stdout: "running\n" }
      return { code: 0, stdout: "" }
    },
    writeFile: async (file, text) => {
      calls.push(`write ${file}`)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, text)
    },
    unlink: async (file) => {
      calls.push(`unlink ${file}`)
      await fs.rm(file, { force: true })
    },
    now: () => 1_700_000_000_000,
  }
}

/**
 * The real `connect` command function against the strict fake control plane,
 * the real host runtime listener, the real serving loop and a relay stub that
 * accepts host tunnels and records the credential each one presents. Beats
 * and the stop signal are driven by hand.
 */
export async function harness(input: { home?: string; cp?: FakeControlPlane; relay?: ReturnType<typeof relayStub> } = {}): Promise<Harness> {
  const home = input.home ?? (await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-connect-")))
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-srv-")))
  const relay = input.relay ?? relayStub()
  const cp = input.cp ?? createFakeConnectControlPlane({ relayUrl: relay.url })
  const lines: string[] = []
  let tick: (() => void) | undefined
  let stop: ((signal: string) => void) | undefined
  let listener: HostRuntimeListener | undefined
  const serviceCalls: string[] = []
  const host: HostDeps = {
    fetch: cp.fetch,
    createListener: async () => {
      listener = await createHostRuntimeListener({ hostname: "127.0.0.1", port: 0, drainTimeoutMs: 500 })
      return listener
    },
    directAddresses: () => [],
    setServing: setHostServing,
    servingState: hostServingState,
    stopServing: stopHostServing,
    resolvePath: (target) => fs.realpath(target),
    setInterval: (fn) => {
      tick = fn
      return { cancel: () => undefined }
    },
    setTimeout: (fn, ms) => {
      const handle = setTimeout(fn, ms)
      return { cancel: () => clearTimeout(handle) }
    },
    onStopSignal: (fn) => {
      stop = fn
      return () => undefined
    },
    now: () => Date.now(),
    monotonicNow: () => performance.now(),
    sleep: async () => undefined,
    log: (line) => lines.push(line),
    pid: process.pid,
  }
  const deps: ConnectDeps = {
    host,
    service: () => serviceDeps(home, serviceCalls),
    store: connectStateStore(home),
    paths: connectPaths(home),
    controlPlaneUrl: cp.url,
    displayName: "build-box",
    removeDir: (dir) => fs.rm(dir, { recursive: true, force: true }),
    desktopDaemon: () => desktopDaemonState({ files: desktopDaemonDiscoveryFiles({}, home) }),
    pairing: defaultPairingDeps(),
  }
  return {
    home,
    root,
    cp,
    relay,
    lines,
    tick: () => tick?.(),
    stop: () => stop?.("SIGTERM"),
    listener: () => listener,
    deps,
    serviceCalls,
  }
}
