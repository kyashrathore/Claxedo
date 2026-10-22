import { expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { OwnedProcess } from "../../contract/node"
import { NO_SHELL_MESSAGE, ownedExecutionEnv, piShell, sessionCommands } from "./shell"

function owned(retired: string[], name: string): OwnedProcess {
  return {
    pid: 1, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exited: new Promise(() => {}),
    retire: async () => { retired.push(name); return { stopped: true } },
  }
}

test("a session's live set disappears when it drains, and retireAll retires every session still holding one", async () => {
  const retired: string[] = []
  const commands = sessionCommands({ spawn: async () => { throw new Error("unused") }, clock: { now: Date.now, setTimeout, clearTimeout },
    log: { debug() {}, info() {}, warn() {}, error() {} } })
  const first = owned(retired, "first")
  commands.of("ses_1").add(first)
  commands.of("ses_2").add(owned(retired, "second"))
  expect(commands.sessions().sort()).toEqual(["ses_1", "ses_2"])
  commands.of("ses_1").delete(first)
  expect(commands.sessions()).toEqual(["ses_2"])
  await commands.retireAll()
  expect(retired).toEqual(["second"])
  expect(commands.sessions()).toEqual([])
})

test("output that arrives after the shell exits still reaches the caller before the result", async () => {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const shell: OwnedProcess = {
    pid: 1, stdin: new PassThrough(), stdout, stderr,
    exited: Promise.resolve({ code: 3, signal: null }),
    retire: async () => ({ stopped: true }),
  }
  const services = { spawn: async () => shell, clock: { now: Date.now, setTimeout, clearTimeout },
    log: { debug() {}, info() {}, warn() {}, error() {} } }
  const env = ownedExecutionEnv({ sessionId: "ses_1", services, env: {}, live: { add() {}, delete() {} }, shell: "/bin/bash" }, "/")
  const seen: string[] = []
  setTimeout(() => { stdout.end("one"); setTimeout(() => stderr.end("two"), 300) }, 0)
  const result = await env.exec("exit 3", { onOutput: (text) => { seen.push(text) } }, BACKGROUND_CONTEXT)
  expect(seen.join("")).toBe("onetwo")
  expect(result).toEqual({ ok: true, value: { exitCode: 3 } })
})

const silent = { debug() {}, info() {}, warn() {}, error() {} }

test("on Windows the command runs in Git for Windows' bash beside the git on PATH, which the installer leaves off PATH itself", async () => {
  const files = new Set(["C:\\Program Files\\Git\\cmd\\git.exe", "C:\\Program Files\\Git\\bin\\bash.exe"])
  const shell = piShell({ platform: "win32", env: { Path: "C:\\node;C:\\Windows\\system32;C:\\Program Files\\Git\\cmd" }, exists: (file) => files.has(file) })
  expect(shell).toBe("C:\\Program Files\\Git\\bin\\bash.exe")
  const spawned: string[] = []
  const shellProcess: OwnedProcess = {
    pid: 1, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exited: Promise.resolve({ code: 0, signal: null }),
    retire: async () => ({ stopped: true }),
  }
  const services = { spawn: async (launch: { file: string }) => { spawned.push(launch.file); return shellProcess },
    clock: { now: Date.now, setTimeout, clearTimeout }, log: silent }
  const env = ownedExecutionEnv({ sessionId: "ses_1", services, env: {}, live: { add() {}, delete() {} }, shell }, "C:\\work\\demo")
  const result = await env.exec("dir", undefined, BACKGROUND_CONTEXT)
  expect(spawned).toEqual(["C:\\Program Files\\Git\\bin\\bash.exe"])
  expect(result).toEqual({ ok: true, value: { exitCode: 0 } })
})

test("a Git install the PATH does not name is found at the installer's default locations, and bash on PATH alone is never taken", () => {
  const exists = (file: string) => file === "C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe" || file === "C:\\Windows\\System32\\bash.exe"
  expect(piShell({ platform: "win32", env: { PATH: "C:\\Windows\\System32", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, exists }))
    .toBe("C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe")
  expect(piShell({ platform: "win32", env: { PATH: "C:\\Windows\\System32", ProgramFiles: "C:\\Program Files" }, exists })).toBeUndefined()
  expect(piShell({ platform: "linux", env: {}, exists: (file) => file === "/bin/bash" })).toBe("/bin/bash")
  expect(piShell({ platform: "darwin", env: {}, exists: () => false })).toBe("bash")
})

test("a Windows box without Git for Windows fails each command with the one line naming the install, without spawning", async () => {
  let spawns = 0
  const services = { spawn: async () => { spawns++; throw new Error("unreachable") }, clock: { now: Date.now, setTimeout, clearTimeout }, log: silent }
  const env = ownedExecutionEnv({ sessionId: "ses_1", services, env: {}, live: { add() {}, delete() {} }, shell: undefined }, "C:\\work\\demo")
  const result = await env.exec("dir", undefined, BACKGROUND_CONTEXT)
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.error.code).toBe("spawn_error")
    expect(result.error.message).toBe(NO_SHELL_MESSAGE)
  }
  expect(spawns).toBe(0)
})
