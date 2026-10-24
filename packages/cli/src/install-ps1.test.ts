import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const installPs1 = path.resolve(import.meta.dir, "..", "install.ps1")
const pwsh = Bun.which("pwsh")
const TOKEN = "chx_inv_2.aHR0cHM6Ly9wbGFuZS50ZXN0.invitation_1.c2VjcmV0"

type FakeConnect = { args: string[]; tokenMode: number; token: string; controlPlane: string | undefined }

function inScratch(body: (scratch: string) => void) {
  const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), "install-ps1-")))
  try {
    body(scratch)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function fakeClaxedo(scratch: string) {
  const bin = path.join(scratch, "bin")
  mkdirSync(bin, { recursive: true })
  writeFileSync(path.join(bin, "claxedo"), `#!/usr/bin/env node
const fs = require("node:fs")
const [command, ...rest] = process.argv.slice(2)
if (command === "--version") { console.log("9.9.9"); process.exit(0) }
const tokenFile = rest[rest.indexOf("--token-file") + 1]
fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({
  args: [command, ...rest],
  tokenMode: fs.statSync(tokenFile).mode & 0o777,
  token: fs.readFileSync(tokenFile, "utf8"),
  controlPlane: process.env.CLAXEDO_CONTROL_PLANE_URL,
}))
`, { mode: 0o755 })
  return bin
}

function fakeNpm(scratch: string) {
  const bin = fakeClaxedo(scratch)
  writeFileSync(path.join(bin, "npm"), `#!/usr/bin/env node
const fs = require("node:fs")
const path = require("node:path")
const args = process.argv.slice(2)
const prefix = args[args.indexOf("--prefix") + 1]
fs.writeFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args))
const runtime = path.join(prefix, "node_modules", "@claxedo", "workspace-runtime", "scripts")
fs.mkdirSync(runtime, { recursive: true })
fs.writeFileSync(path.join(runtime, "install-opencode-node.mjs"), "")
fs.copyFileSync(path.join(__dirname, "claxedo"), path.join(prefix, "claxedo.cmd"))
fs.chmodSync(path.join(prefix, "claxedo.cmd"), 0o755)
console.log("added 880 packages in 18m")
`, { mode: 0o755 })
  return bin
}

function runInstall(scratch: string, args: readonly string[], options: { npm?: boolean; tarball?: boolean } = {}) {
  const node = Bun.which("node")
  expect(node, "a Node 24 on PATH, as on CI's unit lanes").toBeTruthy()
  const log = path.join(scratch, "claxedo-connect.json")
  const npmLog = path.join(scratch, "npm-args.json")
  rmSync(log, { force: true })
  rmSync(npmLog, { force: true })
  const run = spawnSync(pwsh!, ["-NoProfile", "-NonInteractive", "-File", installPs1, ...args], {
    cwd: scratch,
    encoding: "utf8",
    env: {
      PATH: `${options.npm ? fakeNpm(scratch) : fakeClaxedo(scratch)}:${path.dirname(node!)}:/usr/bin:/bin`,
      HOME: scratch,
      CLAXEDO_INSTALL_DIR: path.join(scratch, "install"),
      FAKE_LOG: log,
      FAKE_NPM_LOG: npmLog,
      ...(options.tarball ? { CLAXEDO_CLI_TARBALL: path.join(scratch, "claxedo-cli.tgz") } : {}),
    },
  })
  return {
    run,
    connected: () => (existsSync(log) ? JSON.parse(readFileSync(log, "utf8")) as FakeConnect : undefined),
    npmArgs: () => (existsSync(npmLog) ? JSON.parse(readFileSync(npmLog, "utf8")) as string[] : undefined),
  }
}

describe.skipIf(!pwsh)("install.ps1", () => {
  test("parses, with param the script's first statement", () => {
    const parse = spawnSync(pwsh!, ["-NoProfile", "-NonInteractive", "-Command", `$errors = $null; [System.Management.Automation.Language.Parser]::ParseFile('${installPs1}', [ref]$null, [ref]$errors) | Out-Null; $errors | ForEach-Object { $_.ToString() }`], { encoding: "utf8" })
    expect(parse.status, parse.stderr).toBe(0)
    expect(parse.stdout.trim()).toBe("")
    expect(readFileSync(installPs1, "utf8").split("\n").find((line) => line.trim() && !line.startsWith("#"))).toMatch(/^param\(/)
  })

  test.skipIf(process.platform === "win32")("with an invitation, reuses an accepted claxedo and connects with the invitation in a file only this user reads, the folder and a service", () => inScratch((scratch) => {
    const { run, connected } = runInstall(scratch, ["-Invitation", TOKEN, "-Root", "/srv/my app", "-ControlPlane", "https://plane.test", "-MinimumCliVersion", "0.0.1"])
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout.split("\n").filter((line) => /^\d\/\d /.test(line))).toEqual(["1/3 Node 24", "2/3 claxedo", "3/3 Connecting this machine"])
    expect(connected()).toEqual({
      args: ["connect", "--token-file", path.join(scratch, "install", "invitation.token"), "--root", "/srv/my app", "--install-service"],
      tokenMode: 0o600,
      token: TOKEN,
      controlPlane: "https://plane.test",
    })
  }), 60_000)

  test.skipIf(process.platform === "win32")("with an invitation and no accepted claxedo, connects with the claxedo npm installed, whatever npm printed", () => inScratch((scratch) => {
    const { run, connected } = runInstall(scratch, ["-Invitation", TOKEN, "-Root", "/srv/app", "-ControlPlane", "https://plane.test", "-MinimumCliVersion", "0.0.1"], { npm: true, tarball: true })
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toContain("added 880 packages in 18m")
    expect(connected()?.args).toEqual(["connect", "--token-file", path.join(scratch, "install", "invitation.token"), "--root", "/srv/app", "--install-service"])
  }), 60_000)

  test.skipIf(process.platform === "win32")("with no accepted claxedo and no tarball, installs the registry's claxedo as one package argument", () => inScratch((scratch) => {
    const { run, npmArgs } = runInstall(scratch, [], { npm: true })
    expect(run.status, run.stderr).toBe(0)
    expect(npmArgs()?.filter((arg) => !arg.startsWith("-") && arg !== "install" && arg !== path.join(scratch, "install", "npm"))).toEqual(["@claxedo/cli@latest"])
    expect(run.stdout).toContain(`claxedo is installed at ${path.join(scratch, "install", "npm", "claxedo.cmd")}`)
  }), 60_000)

  test.skipIf(process.platform === "win32")("refuses in one line, before installing anything, an invitation with no folder or a relative one, and a code with an invitation", () => inScratch((scratch) => {
    for (const [args, line] of [
      [["-Invitation", TOKEN], "-Root names the folder to share; copy the command from Connect a machine... again."],
      [["-Invitation", TOKEN, "-Root", "srv/app"], "-Root must be an absolute path on this machine: srv/app"],
      [["K7QM4PXD9R2TWB6HJ3NF", "-Invitation", TOKEN, "-Root", "/srv/app"], "Give a pairing code or an invitation, not both."],
    ] as const) {
      const { run, connected } = runInstall(scratch, [...args, "-MinimumCliVersion", "0.0.1"])
      expect(run.stdout.trim(), args.join(" ")).toBe(line)
      expect(connected()).toBeUndefined()
    }
  }), 60_000)
})
