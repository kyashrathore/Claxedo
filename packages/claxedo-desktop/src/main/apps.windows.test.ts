import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { wslPath } from "./apps"

/**
 * A real `wsl.exe`, not a `.cmd`: Node refuses to spawn a batch file without
 * a shell, so a batch recorder would prove nothing about the argv the
 * process receives. The exe is this runtime with the script embedded, which
 * is why argv starts at index 2 (`["bun", "<embedded path>", ...args]`). It
 * is handed to `wslPath` by path: CreateProcess searches System32 before
 * PATH, so the bare name always finds the system stub.
 */
// The record path is compiled in: a value placed in `process.env` here did
// not reach the child under Bun on Windows.
const recorderSource = (record: string) => `
import { appendFileSync } from "node:fs"
const argv = process.argv.slice(2)
appendFileSync(${JSON.stringify(record)}, JSON.stringify(argv) + "\\n")
process.stdout.write(argv[1] === "sh" ? "/home/acceptance" : "converted:" + argv[3] + "\\n")
`

describe.skipIf(process.platform !== "win32")("wslPath crosses the process boundary to a real wsl.exe with literal argv (wslpath semantics not exercised)", () => {
  let dir: string
  let record: string
  let recorder: string

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "claxedo wsl-"))
    record = path.join(dir, "argv.ndjson")
    recorder = path.join(dir, "wsl.exe")
    const source = path.join(dir, "wsl-recorder.ts")
    writeFileSync(source, recorderSource(record))
    execFileSync(process.execPath, ["build", "--compile", source, "--outfile", recorder], { stdio: "pipe" })
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("a tilde path full of shell text arrives at wslpath as one literal argument", () => {
    const suffix = "/work/$(id)/`id`/a&b/has space/%PATH%%"

    expect(wslPath(`~${suffix}`, "linux", recorder)).toBe(`converted:/home/acceptance${suffix}`)

    const calls = readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[])
    expect(calls).toEqual([
      ["-e", "sh", "-c", 'printf %s "$HOME"'],
      ["-e", "wslpath", "-u", `/home/acceptance${suffix}`],
    ])
  })
})
