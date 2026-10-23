import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { cleanLine, installCommand, isUnknownHostKey, readSshTarget, runSshTool, sshArgv, sshFailure, type SshTools } from "./ssh"

const UNKNOWN_HOST = "No ED25519 host key is known for [localhost]:2222 and you have requested strict checking.\nHost key verification failed.\n"
const CHANGED_HOST = [
  "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
  "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @",
  "Host key for [localhost]:2222 has changed and you have requested strict checking.",
  "Host key verification failed.",
].join("\n")

const node: SshTools = { ssh: process.execPath, sshKeygen: process.execPath }

describe("reading the target the person typed", () => {
  test("takes user@host or a config alias, with an optional port, key and folder", () => {
    expect(readSshTarget({ destination: " ubuntu@build-box.local " })).toEqual({ destination: "ubuntu@build-box.local" })
    expect(readSshTarget({ destination: "build-box", port: 2222, identityFile: "~/.ssh/work", folder: "~/code/app" })).toEqual({
      destination: "build-box",
      port: 2222,
      identityFile: join(homedir(), ".ssh/work"),
      folder: "~/code/app",
    })
    expect(readSshTarget({ destination: "root@10.0.0.7", identityFile: " ", folder: "" })).toEqual({ destination: "root@10.0.0.7" })
  })

  test("refuses anything ssh would read as an option, and malformed fields", () => {
    for (const destination of ["-oProxyCommand=id", "user@-oProxyCommand=id", "-l root host", "us er@host", "user@host;id", "user@", "", "a@b\nc"]) {
      expect(readSshTarget({ destination }), destination).toBeUndefined()
    }
    expect(readSshTarget({ destination: "host", port: 0 })).toBeUndefined()
    expect(readSshTarget({ destination: "host", port: 70_000 })).toBeUndefined()
    expect(readSshTarget({ destination: "host", port: "22" })).toBeUndefined()
    expect(readSshTarget({ destination: "host", folder: "a\nb" })).toBeUndefined()
    expect(readSshTarget({ destination: "host", identityFile: 7 })).toBeUndefined()
    expect(readSshTarget("host")).toBeUndefined()
  })

  test("every option precedes the destination, which follows --, and nothing is forwarded", () => {
    const argv = sshArgv({ destination: "ubuntu@box", port: 2222, identityFile: "/keys/id" }, "uname -sm")
    const end = argv.indexOf("--")
    expect(argv.slice(end)).toEqual(["--", "ubuntu@box", "uname -sm"])
    expect(argv.slice(0, end)).toEqual(expect.arrayContaining(["-T", "-a", "-x", "BatchMode=yes", "StrictHostKeyChecking=yes", "ClearAllForwardings=yes"]))
    expect(argv.slice(0, end).join(" ")).toContain("-p 2222 -i /keys/id")
  })
})

describe.skipIf(process.platform === "win32")("the remote install command", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "claxedo-ssh-home-")))
  const awkward = join(home, "it's $HOME `id`")
  mkdirSync(join(home, "code", "my app"), { recursive: true })
  mkdirSync(awkward)
  const script = 'printf "%s|%s\\n" "$(pwd)" "$1"\n'
  const run = (folder: string | undefined) =>
    spawnSync("sh", ["-c", installCommand(folder, "K7QM4PXD9R2TWB6HJ3NF")], { input: script, cwd: home, env: { HOME: home, PATH: process.env.PATH ?? "" }, encoding: "utf8" })

  test("runs the piped script in the chosen folder with the code as its argument", () => {
    expect(run(undefined).stdout).toBe(`${home}|K7QM4PXD9R2TWB6HJ3NF\n`)
    expect(run("~").stdout).toBe(`${home}|K7QM4PXD9R2TWB6HJ3NF\n`)
    expect(run("~/code/my app").stdout).toBe(`${join(home, "code", "my app")}|K7QM4PXD9R2TWB6HJ3NF\n`)
    expect(run(join(home, "code")).stdout).toBe(`${join(home, "code")}|K7QM4PXD9R2TWB6HJ3NF\n`)
    expect(run(awkward).stdout).toBe(`${awkward}|K7QM4PXD9R2TWB6HJ3NF\n`)
  })

  test("exits 66 without running anything when the folder is not there", () => {
    const missing = run("~/nowhere")
    expect(missing.status).toBe(66)
    expect(missing.stdout).toBe("")
    rmSync(home, { recursive: true, force: true })
  })
})

describe("running ssh", () => {
  test("streams clean lines from both streams, reports the exit code and the last line", async () => {
    const lines: string[] = []
    const exit = await runSshTool(node, "ssh", ["-e", 'process.stdout.write("1/4 Checking\\n\\u001b[31m2/4 Node 24\\u001b[0m\\r\\n"); process.stderr.write("fail: no npm\\n"); process.exit(3)'], {
      onLine: (line) => lines.push(line),
    })
    expect(exit).toMatchObject({ kind: "exited", code: 3, lastLine: "fail: no npm" })
    expect(lines).toEqual(["1/4 Checking", "2/4 Node 24", "fail: no npm"])
  })

  test("hands the input to stdin and closes it", async () => {
    const exit = await runSshTool(node, "ssh", ["-e", 'let s = ""; process.stdin.on("data", (c) => (s += c)); process.stdin.on("end", () => console.log(s.length + ":" + s))'], {
      input: Buffer.from("#!/bin/sh\necho hi\n"),
    })
    expect(exit).toMatchObject({ kind: "exited", code: 0, stdout: "18:#!/bin/sh\necho hi\n\n" })
  })

  test("stops at its deadline and when its signal aborts", async () => {
    const hang = ["-e", "setInterval(() => {}, 1000)"]
    const timedOut = await runSshTool(node, "ssh", hang, { deadlineMs: 200 })
    expect(timedOut).toMatchObject({ kind: "exited", code: null })
    const controller = new AbortController()
    const running = runSshTool(node, "ssh", hang, { signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    expect(await running).toMatchObject({ kind: "exited", code: null })
  })

  test("names a missing ssh as missing", async () => {
    expect(await runSshTool({ ssh: "claxedo-no-such-ssh", sshKeygen: "x" }, "ssh", [])).toEqual({ kind: "missing" })
  })

  test("long lines are cut and control bytes dropped", () => {
    expect(cleanLine(`  ${"x".repeat(300)}\u0007 `)).toHaveLength(240)
    expect(cleanLine("\u001b[1;32mok\u001b[0m")).toBe("ok")
  })
})

describe("reading ssh's own failures", () => {
  test("tells an unknown host from a changed one, refused auth and an unreachable host", () => {
    expect(isUnknownHostKey(UNKNOWN_HOST)).toBe(true)
    expect(isUnknownHostKey(CHANGED_HOST)).toBe(false)
    expect(sshFailure(CHANGED_HOST)).toBe("hostKeyChanged")
    expect(sshFailure("sshtester@localhost: Permission denied (publickey).\n")).toBe("authRefused")
    expect(sshFailure("Received disconnect from 10.0.0.7 port 22:2: Too many authentication failures\n")).toBe("authRefused")
    expect(sshFailure("ssh: connect to host localhost port 2299: Connection refused\n")).toBe("unreachable")
    expect(sshFailure("ssh: Could not resolve hostname no-such-host.invalid: Name or service not known\n")).toBe("unreachable")
    expect(isUnknownHostKey("ssh: connect to host localhost port 2299: Connection refused\n")).toBe(false)
  })
})
