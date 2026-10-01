import { afterAll, beforeEach, expect, mock, test } from "bun:test"
import { EventEmitter } from "node:events"
import path from "node:path"
import { REPO_ROOT } from "./node-loader"

const launches: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = []
const childProcess = await import("node:child_process")
const originals = await Promise.all([
  ["node:child_process", childProcess],
  ["./daemon-dirs", await import("./daemon-dirs")],
  ["./isolated-env", await import("./isolated-env")],
  ["./model-catalog", await import("./model-catalog")],
  ["./health", await import("./health")],
  ["./process", await import("./process")],
  ["./scripted-world", await import("./scripted-world")],
  ["../../../claxedo-app/e2e/harness/scripted-world", await import("../../../claxedo-app/e2e/harness/scripted-world")],
].map(([name, module]) => [name as string, { ...module as object }] as const))
afterAll(() => { for (const [name, module] of originals) mock.module(name, () => module) })
mock.module("node:child_process", () => ({
  ...childProcess,
  execFileSync: () => "v24.15.0",
  spawn: (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    launches.push({ command, args, env: options.env })
    return Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 123,
      exitCode: null, signalCode: null,
    })
  },
}))
mock.module("./daemon-dirs", () => ({ daemonDirs: async (root: string) => ({ acpScriptDir: `${root}/acp-scripts`, workspaces: `${root}/workspaces` }) }))
mock.module("./isolated-env", () => ({ isolatedEnv: async (root: string) => ({ HOME: root, PATH: "/test/bin" }) }))
mock.module("./model-catalog", () => ({ writeScriptedModelCatalog: async () => "/test/catalog.json" }))
mock.module("./health", () => ({ waitForHealth: async () => {} }))
mock.module("./process", () => ({ captureOutput: (child: unknown) => ({ child, log: () => "" }), stopProcess: async () => {}, exited: async () => 0 }))
mock.module("./scripted-world", () => ({ prepareScriptedServer: async () => {} }))
mock.module("../../../claxedo-app/e2e/harness/scripted-world", () => ({ prepareScriptedServer: async () => {} }))

const { startDaemon } = await import("./daemon")
const { startDaemon: startAppDaemon } = await import("../../../claxedo-app/e2e/harness/daemon")
const input = {
  dataDir: "/test/isolated", guardUrl: "http://127.0.0.1:41000", port: 41001,
  red: false, scripted: {} as Parameters<typeof startDaemon>[0]["scripted"],
}
const entry = path.join(import.meta.dirname, "local-daemon-entry.ts")

beforeEach(() => { launches.length = 0 })

test("harness local flow launches the local daemon on Node with its isolated state", async () => {
  const daemon = await startDaemon(input)
  expect(launches[0].command).toBe("node")
  expect(launches[0].args.at(-1)).toBe(entry)
  expect(launches[0].env.CLAXEDO_DATA_DIR).toBe(input.dataDir)
  expect(launches[0].env.TSX_TSCONFIG_PATH).toBe(path.join(REPO_ROOT, "packages/claxedo-local-server/tsconfig.json"))
  await daemon.restart()
  expect(launches[1].args.at(-1)).toBe(entry)
})

test("app local flow launches the same daemon and passes its app bundle", async () => {
  const daemon = await startAppDaemon({ ...input, distDir: "/test/app" })
  expect(launches[0].args.at(-1)).toBe(entry)
  expect(launches[0].env.CLAXEDO_APP_DIST_DIR).toBe("/test/app")
  expect(launches[0].env.TSX_TSCONFIG_PATH).toBe(path.join(REPO_ROOT, "packages/claxedo-local-server/tsconfig.json"))
  await daemon.restart()
  expect(launches[1].args.at(-1)).toBe(entry)
})
