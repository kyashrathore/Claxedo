import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execFileSync, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { urlLaunchCommand } from "./open-url"

/**
 * Registers a URL scheme in the current user's registry, so it runs only on
 * the acceptance lane that opts in with `CLAXEDO_WINDOWS_ACL_ACCEPTANCE`, the
 * way `windows-private-file.test.ts` gates its privileged proofs.
 *
 * What is exercised is `rundll32 url.dll,FileProtocolHandler <url>` reaching a
 * registered handler with the URL intact — the argument-passing claim behind
 * choosing rundll32 over `cmd /c start`. The default browser is not in the
 * chain: the scheme is private and its handler is the recorder below.
 */
const demanded = process.env.CLAXEDO_WINDOWS_ACL_ACCEPTANCE === "1"

/**
 * The handler records both its parsed argv and the raw command line the shell
 * built from the `"%1"` template, read back through WMI, because a `"` inside
 * the URL is substituted verbatim and splits argv while the command line still
 * carries every byte.
 */
const RECORDER = `
const fs = require("node:fs")
const { execFileSync } = require("node:child_process")
const commandLine = execFileSync("powershell.exe", [
  "-NoProfile", "-NonInteractive", "-Command",
  "(Get-CimInstance Win32_Process -Filter 'ProcessId = " + process.pid + "').CommandLine",
], { encoding: "utf8" }).trim()
const out = process.argv[2]
fs.writeFileSync(out + ".tmp", JSON.stringify({ argv: process.argv.slice(3), commandLine }))
fs.renameSync(out + ".tmp", out)
`

type HandlerRecord = { argv: string[]; commandLine: string }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function reg(...args: string[]) {
  return execFileSync("reg.exe", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}

describe.skipIf(process.platform !== "win32" || !demanded)("rundll32 hands a URL to its registered handler byte-for-byte (default browser not exercised)", () => {
  const scheme = `claxedo-acceptance-${randomUUID().slice(0, 8)}`
  const key = `HKCU\\Software\\Classes\\${scheme}`
  let dir: string
  let recorder: string
  let record: string
  let template: string

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "claxedo url-"))
    recorder = path.join(dir, "recorder.cjs")
    record = path.join(dir, "record.json")
    writeFileSync(recorder, RECORDER)
    template = `"${process.execPath}" "${recorder}" "${record}" "%1"`
    try {
      reg("add", key, "/ve", "/t", "REG_SZ", "/d", `URL:${scheme}`, "/f")
      reg("add", key, "/v", "URL Protocol", "/t", "REG_SZ", "/d", "", "/f")
      reg("add", `${key}\\shell\\open\\command`, "/ve", "/t", "REG_SZ", "/d", template, "/f")
      const stored = reg("query", `${key}\\shell\\open\\command`, "/ve")
      if (!stored.includes(template)) throw new Error(`registered handler command differs from the template:\n${stored}`)
    } catch (error) {
      reg("delete", key, "/f")
      throw error
    }
  })

  afterAll(() => {
    try {
      reg("delete", key, "/f")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  async function open(url: string): Promise<HandlerRecord> {
    rmSync(record, { force: true })
    const launch = urlLaunchCommand("win32", "https://acceptance.invalid/")
    const child = spawn(launch.command, [...launch.args.slice(0, -1), url], { stdio: "ignore", windowsHide: true })
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", () => resolve())
    })
    const deadline = Date.now() + 15_000
    while (!existsSync(record)) {
      if (Date.now() > deadline) throw new Error(`the ${scheme} handler never ran for ${url.slice(0, 120)}`)
      await sleep(50)
    }
    return JSON.parse(readFileSync(record, "utf8")) as HandlerRecord
  }

  const expectedCommandLine = (url: string) => `"${process.execPath}" "${recorder}" "${record}" "${url}"`

  test("cmd.exe metacharacters, a %VAR% sequence and encoded spaces arrive unparsed", async () => {
    const url = `${scheme}://device?user_code=AB&next=%26whoami|dir^c%PATH%%25&title=a%20b&q='single'`
    const received = await open(url)
    expect(received.argv).toEqual([url])
    expect(received.commandLine).toBe(expectedCommandLine(url))
  })

  test("a double quote inside the URL still reaches the handler's command line", async () => {
    const url = `${scheme}://device?code="AB"&next=x`
    const received = await open(url)
    expect(received.commandLine).toBe(expectedCommandLine(url))
  })

  test("a 4 KB query is delivered whole", async () => {
    const url = `${scheme}://device?pad=${"q".repeat(4096)}`
    const received = await open(url)
    expect(received.argv).toEqual([url])
    expect(received.commandLine).toBe(expectedCommandLine(url))
  })
})
