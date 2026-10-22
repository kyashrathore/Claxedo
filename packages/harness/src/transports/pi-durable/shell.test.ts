import { expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { OwnedProcess } from "../../contract/node"
import { RUNNER_RESTARTED_NOTICE } from "./runner"
import type { RunnerReply, RunnerRequest } from "./runner-protocol"
import { NO_SHELL_MESSAGE, ownedExecutionEnv, piShell, sessionCommands } from "./shell"

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const clock = { now: Date.now, setTimeout, clearTimeout }
const RUNNER = () => ({ file: "/usr/bin/node", args: ["/opt/claxedo/pi-runner.mjs"] })

type FakeRunner = {
  owned: OwnedProcess
  silent: boolean
  requests: RunnerRequest[]
  reply(reply: RunnerReply): void
  exit(code: number): void
  retired: number
}

function fakeRunner(): FakeRunner {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const fake: FakeRunner = {
    silent: false,
    requests: [],
    retired: 0,
    reply: (reply) => { stdout.write(`${JSON.stringify(reply)}\n`) },
    exit: () => {},
    owned: undefined as unknown as OwnedProcess,
  }
  const { promise: exited, resolve } = Promise.withResolvers<{ code: number | null; signal: string | null }>()
  fake.exit = (code) => resolve({ code, signal: null })
  let buffer = ""
  stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString()
    let at = buffer.indexOf("\n")
    while (at >= 0) {
      const request = JSON.parse(buffer.slice(0, at)) as RunnerRequest
      fake.requests.push(request)
      if (request.kind === "run" && !fake.silent) fake.reply({ kind: "started", id: request.id, pid: 10 })
      buffer = buffer.slice(at + 1)
      at = buffer.indexOf("\n")
    }
  })
  fake.owned = { pid: 4242, stdin, stdout, stderr: new PassThrough(), exited, retire: async () => { fake.retired++; return { stopped: true } } }
  return fake
}

async function until(check: () => boolean, ms = 2_000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition never held")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function host(runners: FakeRunner[]) {
  const spawned: string[] = []
  const services = {
    spawn: async (command: { file: string }) => { spawned.push(command.file); const next = runners.shift(); if (!next) throw new Error("no runner left to start"); return next.owned },
    clock, log: silent,
  }
  const commands = sessionCommands(services, RUNNER, { PATH: "/usr/bin" })
  const env = ownedExecutionEnv({ sessionId: "ses_1", services, env: { PATH: "/usr/bin" }, runner: commands.of("ses_1", "/work"), shell: "/bin/bash" }, "/work")
  return { env, commands, spawned }
}

test("two commands of a session share one shell host, each as its own run with its own output and exit code", async () => {
  const runner = fakeRunner()
  const { env, spawned } = host([runner])
  const first: string[] = []
  const firstResult = env.exec("echo one", { onOutput: (text) => { first.push(text) } }, BACKGROUND_CONTEXT)
  await until(() => runner.requests.length === 1)
  expect(runner.requests[0]).toMatchObject({ kind: "run", id: "run-1", file: "/bin/bash", args: ["-c", "echo one"], cwd: "/work", env: { PATH: "/usr/bin" } })
  runner.reply({ kind: "output", id: "run-1", stream: "stdout", data: Buffer.from("one\n").toString("base64") })
  runner.reply({ kind: "exit", id: "run-1", code: 0, signal: null })
  expect(await firstResult).toEqual({ ok: true, value: { exitCode: 0 } })
  expect(first.join("")).toBe("one\n")
  expect(runner.requests.at(-1)).toEqual({ kind: "release", id: "run-1" })

  const second = env.exec("exit 3", undefined, BACKGROUND_CONTEXT)
  await until(() => runner.requests.some((request) => request.kind === "run" && request.id === "run-2"))
  runner.reply({ kind: "exit", id: "run-2", code: 3, signal: null })
  expect(await second).toEqual({ ok: true, value: { exitCode: 3 } })
  expect(spawned, "one host for both commands").toEqual(["/usr/bin/node"])
}, 10_000)

test("an abort kills only the aborted command, and the other command of the host finishes", async () => {
  const runner = fakeRunner()
  const { env } = host([runner])
  const controller = new AbortController()
  const aborted = env.exec("sleep 60", undefined, { ...BACKGROUND_CONTEXT, abortSignal: controller.signal })
  const kept = env.exec("echo kept", undefined, BACKGROUND_CONTEXT)
  await until(() => runner.requests.filter((request) => request.kind === "run").length === 2)
  controller.abort()
  await until(() => runner.requests.some((request) => request.kind === "kill"))
  expect(runner.requests.filter((request) => request.kind === "kill")).toEqual([{ kind: "kill", id: "run-1" }])
  runner.reply({ kind: "exit", id: "run-1", code: null, signal: "SIGKILL" })
  runner.reply({ kind: "exit", id: "run-2", code: 0, signal: null })
  expect(await aborted).toMatchObject({ ok: false, error: { code: "aborted" } })
  expect(await kept).toEqual({ ok: true, value: { exitCode: 0 } })
}, 10_000)

test("a shell host that dies fails the command it was running in one line, and the next command starts a new host and says so first", async () => {
  const first = fakeRunner()
  const second = fakeRunner()
  const { env, spawned } = host([first, second])
  const running = env.exec("npm run dev", undefined, BACKGROUND_CONTEXT)
  await until(() => first.requests.length === 1)
  first.exit(137)
  expect(await running).toMatchObject({ ok: false, error: { code: "spawn_error", message: "The shell host ended (code 137)" } })

  const output: string[] = []
  const next = env.exec("echo again", { onOutput: (text) => { output.push(text) } }, BACKGROUND_CONTEXT)
  await until(() => second.requests.length === 1)
  second.reply({ kind: "output", id: "run-2", stream: "stdout", data: Buffer.from("again\n").toString("base64") })
  second.reply({ kind: "exit", id: "run-2", code: 0, signal: null })
  expect(await next).toEqual({ ok: true, value: { exitCode: 0 } })
  expect(output.join("")).toBe(`${RUNNER_RESTARTED_NOTICE}\nagain\n`)
  expect(spawned).toEqual(["/usr/bin/node", "/usr/bin/node"])
}, 10_000)

test("a command whose host died before accepting it runs once on the next host, never twice", async () => {
  const first = fakeRunner()
  first.silent = true
  const second = fakeRunner()
  const { env, spawned } = host([first, second])
  const output: string[] = []
  const run = env.exec("echo once", { onOutput: (text) => { output.push(text) } }, BACKGROUND_CONTEXT)
  await until(() => first.requests.length === 1)
  first.exit(1)
  await until(() => second.requests.length === 1)
  expect(second.requests[0]).toMatchObject({ kind: "run", id: "run-2", args: ["-c", "echo once"] })
  second.reply({ kind: "output", id: "run-2", stream: "stdout", data: Buffer.from("once\n").toString("base64") })
  second.reply({ kind: "exit", id: "run-2", code: 0, signal: null })
  expect(await run).toEqual({ ok: true, value: { exitCode: 0 } })
  expect(output.join("")).toBe(`${RUNNER_RESTARTED_NOTICE}\nonce\n`)
  expect(spawned).toEqual(["/usr/bin/node", "/usr/bin/node"])
}, 10_000)

test("retiring a session ends its host before retiring the launch, and a session that never ran a command has nothing to end", async () => {
  const runner = fakeRunner()
  const { env, commands } = host([runner])
  const run = env.exec("true", undefined, BACKGROUND_CONTEXT)
  await until(() => runner.requests.length === 1)
  runner.reply({ kind: "exit", id: "run-1", code: 0, signal: null })
  await run
  const ending = commands.retire("ses_1")
  await until(() => runner.requests.some((request) => request.kind === "end"))
  runner.exit(0)
  await ending
  expect(runner.retired).toBe(1)
  expect(commands.sessions()).toEqual([])
  await commands.retire("ses_never")
}, 10_000)

test("a Windows box without Git for Windows fails each command with the one line naming the install, without starting a host", async () => {
  let spawns = 0
  const services = { spawn: async () => { spawns++; throw new Error("unreachable") }, clock, log: silent }
  const commands = sessionCommands(services, RUNNER, {})
  const env = ownedExecutionEnv({ sessionId: "ses_1", services, env: {}, runner: commands.of("ses_1", "C:\\work\\demo"), shell: undefined }, "C:\\work\\demo")
  const result = await env.exec("dir", undefined, BACKGROUND_CONTEXT)
  expect(result).toMatchObject({ ok: false, error: { code: "spawn_error", message: NO_SHELL_MESSAGE } })
  expect(spawns).toBe(0)
})

test("on Windows the shell is Git for Windows' bash under ProgramFiles, then beside the git on PATH, then a bash.exe on PATH other than WSL's launcher", () => {
  const programFiles = "C:\\Program Files\\Git\\bin\\bash.exe"
  const besideGit = "D:\\tools\\Git\\bin\\bash.exe"
  const msys = "C:\\msys64\\usr\\bin\\bash.exe"
  const wsl = "C:\\Windows\\System32\\bash.exe"
  const env = { Path: "C:\\Windows\\System32;D:\\tools\\Git\\cmd;C:\\msys64\\usr\\bin", ProgramFiles: "C:\\Program Files" }
  const gitOnPath = (file: string) => file === "D:\\tools\\Git\\cmd\\git.exe"
  expect(piShell({ platform: "win32", env, exists: (file) => gitOnPath(file) || [programFiles, besideGit, msys, wsl].includes(file) })).toBe(programFiles)
  expect(piShell({ platform: "win32", env, exists: (file) => gitOnPath(file) || [besideGit, msys, wsl].includes(file) })).toBe(besideGit)
  expect(piShell({ platform: "win32", env, exists: (file) => [msys, wsl].includes(file) })).toBe(msys)
  expect(piShell({ platform: "win32", env, exists: (file) => file === wsl })).toBeUndefined()
  expect(piShell({ platform: "linux", env: {}, exists: (file) => file === "/bin/bash" })).toBe("/bin/bash")
  expect(piShell({ platform: "darwin", env: {}, exists: () => false })).toBe("bash")
})
