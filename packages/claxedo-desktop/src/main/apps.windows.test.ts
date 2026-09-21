import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { wslPath } from "./apps"

const RECORD_ENV = "WSL_ARGV_RECORD"

/**
 * A real `wsl.exe`, not a `.cmd`: Node refuses to spawn a batch file without
 * a shell and libuv's PATH walk only appends `.com`/`.exe`, so a batch
 * recorder would prove nothing about how `execFileSync("wsl")` resolves. The
 * exe is this runtime with the script embedded, which is why argv starts at
 * index 2 (`["bun", "<embedded path>", ...args]`).
 */
const RECORDER = `
import { appendFileSync } from "node:fs"
const argv = process.argv.slice(2)
appendFileSync(process.env[${JSON.stringify(RECORD_ENV)}], JSON.stringify(argv) + "\\n")
process.stdout.write(argv[1] === "sh" ? "/home/acceptance" : "converted:" + argv[3] + "\\n")
`

const PATH_KEY = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH"

describe.skipIf(process.platform !== "win32")("wslPath crosses the process boundary to a real wsl.exe with literal argv (wslpath semantics not exercised)", () => {
  let dir: string
  let record: string
  const saved = { path: process.env[PATH_KEY], record: process.env[RECORD_ENV] }

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "claxedo wsl-"))
    record = path.join(dir, "argv.ndjson")
    const source = path.join(dir, "wsl-recorder.ts")
    writeFileSync(source, RECORDER)
    execFileSync(process.execPath, ["build", "--compile", source, "--outfile", path.join(dir, "wsl.exe")], { stdio: "pipe" })
    process.env[PATH_KEY] = `${dir};${saved.path ?? ""}`
    process.env[RECORD_ENV] = record
  })

  afterAll(() => {
    process.env[PATH_KEY] = saved.path
    if (saved.record === undefined) delete process.env[RECORD_ENV]
    else process.env[RECORD_ENV] = saved.record
    rmSync(dir, { recursive: true, force: true })
  })

  test("a tilde path full of shell text arrives at wslpath as one literal argument", () => {
    const suffix = "/work/$(id)/`id`/a&b/has space/%PATH%%"

    expect(wslPath(`~${suffix}`, "linux")).toBe(`converted:/home/acceptance${suffix}`)

    const calls = readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[])
    expect(calls).toEqual([
      ["-e", "sh", "-c", 'printf %s "$HOME"'],
      ["-e", "wslpath", "-u", `/home/acceptance${suffix}`],
    ])
  })
})
