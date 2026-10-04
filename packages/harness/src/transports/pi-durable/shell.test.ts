import { expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { OwnedProcess } from "../../contract/node"
import { ownedExecutionEnv, sessionCommands } from "./shell"

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
  const env = ownedExecutionEnv({ sessionId: "ses_1", services, env: {}, live: { add() {}, delete() {} } }, "/")
  const seen: string[] = []
  setTimeout(() => { stdout.end("one"); setTimeout(() => stderr.end("two"), 300) }, 0)
  const result = await env.exec("exit 3", { onOutput: (text) => { seen.push(text) } }, BACKGROUND_CONTEXT)
  expect(seen.join("")).toBe("onetwo")
  expect(result).toEqual({ ok: true, value: { exitCode: 3 } })
})
