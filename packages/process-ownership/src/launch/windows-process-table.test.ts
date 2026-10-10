import { expect, test } from "bun:test"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { once } from "node:events"
import path from "node:path"
import { createWindowsProcessTable } from "./windows-process-table"

// Stands in for the PowerShell program: answers in order, one line per pid,
// and misbehaves on the pids below.
const interpreter = `
const { createInterface } = require("node:readline")
const lines = createInterface({ input: process.stdin })
let chain = Promise.resolve()
lines.on("line", (line) => { chain = chain.then(() => answer(Number(line))) })
lines.on("close", () => chain.then(() => process.exit(0)))
const write = (text) => process.stdout.write(text + "\\n")
async function answer(pid) {
  if (pid === 200) return write("absent")
  if (pid === 300) return write("error Access is denied.")
  if (pid === 400) return new Promise(() => {})
  if (pid === 500) { process.stderr.write("the interpreter failed to load CIM\\n"); process.exit(3) }
  if (pid === 600) return write("Get-CimInstance : not a row")
  if (pid === 700) await new Promise((resolve) => setTimeout(resolve, 600))
  write("row 2026-10-10T20:58:24.8238420Z 4116")
}`

const row = { creationDate: "2026-10-10T20:58:24.8238420Z", parentPid: 4116 }

function table() {
  const launched: ChildProcessWithoutNullStreams[] = []
  const reader = createWindowsProcessTable({
    launch: () => {
      const child = spawn(process.execPath, ["-e", interpreter], { stdio: ["pipe", "pipe", "pipe"] })
      launched.push(child)
      return child
    },
  })
  return { reader, launched }
}

test("reads sent together are answered in order by one interpreter", async () => {
  const { reader, launched } = table()
  expect(await Promise.all([reader.read(100, 5_000), reader.read(200, 5_000), reader.read(100, 5_000)])).toEqual([row, undefined, row])
  expect(launched).toHaveLength(1)
  reader.release()
})

test("a read the table refuses fails alone, and the interpreter keeps serving", async () => {
  const { reader, launched } = table()
  await expect(reader.read(300, 5_000)).rejects.toThrow("Access is denied.")
  expect(await reader.read(100, 5_000)).toEqual(row)
  expect(launched).toHaveLength(1)
  reader.release()
})

test("a read past its bound is refused and the wedged interpreter is replaced", async () => {
  const { reader, launched } = table()
  await expect(reader.read(400, 200)).rejects.toThrow("did not answer for pid 400 within 200ms")
  expect(await reader.read(100, 5_000)).toEqual(row)
  expect(launched).toHaveLength(2)
  expect(launched[0]!.killed).toBe(true)
  reader.release()
})

test("an unbounded read keeps the interpreter its slow answer is coming from", async () => {
  const { reader, launched } = table()
  const [unbounded, bounded] = await Promise.allSettled([reader.read(700, 0), reader.read(100, 200)])
  expect(unbounded).toEqual({ status: "fulfilled", value: row })
  expect(bounded.status).toBe("rejected")
  expect(launched).toHaveLength(1)
  reader.release()
})

test("an interpreter that exits fails what it was asked with what it said, and the next read starts another", async () => {
  const { reader, launched } = table()
  await expect(reader.read(500, 5_000)).rejects.toThrow("the interpreter failed to load CIM")
  expect(await reader.read(100, 5_000)).toEqual(row)
  expect(launched).toHaveLength(2)
  reader.release()
})

test("an answer in no form the program writes discards the interpreter", async () => {
  const { reader, launched } = table()
  await expect(reader.read(600, 5_000)).rejects.toThrow("unexpected form")
  expect(await reader.read(100, 5_000)).toEqual(row)
  expect(launched).toHaveLength(2)
  reader.release()
})

test("a released interpreter exits once it has answered", async () => {
  const { reader, launched } = table()
  const answer = reader.read(100, 5_000)
  reader.release()
  expect(await answer).toEqual(row)
  // An idle reader is unreferenced, and Bun on Windows delivers nothing to a
  // loop that only unreferenced handles hold, its exit included.
  launched[0]!.ref()
  const [code] = await once(launched[0]!, "exit")
  expect(code).toBe(0)
})

test("an idle interpreter does not keep its host process alive", async () => {
  const host = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process")
    const { createWindowsProcessTable } = await import(${JSON.stringify(path.join(import.meta.dir, "windows-process-table.ts"))})
    const reader = createWindowsProcessTable({ launch: () => spawn(process.execPath, ["-e", ${JSON.stringify(interpreter)}], { stdio: ["pipe", "pipe", "pipe"] }) })
    console.log(JSON.stringify(await reader.read(100, 5_000)))
  `], { stdio: ["ignore", "pipe", "inherit"] })
  let output = ""
  host.stdout.on("data", (chunk: Buffer) => { output += chunk.toString() })
  const [code] = await once(host, "exit")
  expect(code).toBe(0)
  expect(JSON.parse(output)).toEqual(row)
}, 15_000)
