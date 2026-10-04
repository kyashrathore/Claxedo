import { expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import type { OwnedProcess } from "../../contract/node"
import { sessionCommands } from "./shell"

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
