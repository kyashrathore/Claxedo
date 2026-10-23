import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const installSh = readFileSync(path.join(root, "install.sh"), "utf8")

test("install.sh installs with every install script off and then runs the one the runtime needs", () => {
  const installs = installSh.split("\n").filter((line) => /^\s*npm install /.test(line))
  expect(installs).toHaveLength(2)
  for (const line of installs) expect(line).toContain("npm install -g --ignore-scripts ")

  const runtime = JSON.parse(readFileSync(path.join(root, "../workspace-runtime/package.json"), "utf8"))
  expect(Object.keys(runtime.scripts).filter((name) => /^(pre|post)?install$/.test(name))).toEqual(["postinstall"])
  expect(runtime.scripts.postinstall).toBe("node scripts/install-opencode-node.mjs")
  expect(installSh).toContain(`node "$runtime_dir/scripts/install-opencode-node.mjs"`)
})

function packFake(dir: string, manifest: Record<string, unknown>, files: Record<string, string>) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest))
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    writeFileSync(path.join(dir, name), text, { mode: 0o755 })
  }
  const packed = spawnSync("npm", ["pack", "--silent", "--pack-destination", dir], { cwd: dir, encoding: "utf8" })
  expect(packed.status, packed.stderr).toBe(0)
  return path.join(dir, packed.stdout.trim())
}

// npm 11 prints a UUID-shaped path segment as `***` in `npm prefix -g` and
// `npm root -g`, so a prefix under such a directory is one npm itself misreports.
test.skipIf(process.platform === "win32")("install.sh installs into the npm prefix the person set, even under a UUID-shaped directory", () => {
  const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), "install-sh-")))
  try {
    const prefix = path.join(scratch, crypto.randomUUID(), "prefix")
    mkdirSync(prefix, { recursive: true })
    const home = path.join(scratch, "home")
    mkdirSync(home)
    const cli = packFake(path.join(scratch, "cli"), { name: "@claxedo/cli", version: "0.0.0-test", bin: { claxedo: "bin.js" } }, {
      "bin.js": "#!/usr/bin/env node\nconsole.log(\"claxedo help\")\n",
    })
    const runtime = packFake(path.join(scratch, "runtime"), { name: "@claxedo/workspace-runtime", version: "0.0.0-test" }, {
      "scripts/install-opencode-node.mjs": "",
    })
    const node = Bun.which("node")
    expect(node, "a Node 24 on PATH, as on CI's unit lanes").toBeTruthy()

    const run = spawnSync("sh", [path.join(root, "install.sh")], {
      cwd: scratch,
      encoding: "utf8",
      env: {
        HOME: home,
        PATH: `${path.dirname(node!)}:/usr/bin:/bin`,
        npm_config_prefix: prefix,
        npm_config_cache: path.join(scratch, "npm-cache"),
        npm_config_update_notifier: "false",
        CLAXEDO_CLI_TARBALL: `${cli} ${runtime}`,
      },
    })

    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toContain(`claxedo is installed at ${prefix}/bin/claxedo`)
    expect(existsSync(path.join(prefix, "bin", "claxedo"))).toBe(true)
    expect(existsSync(path.join(home, ".claxedo")), "no private prefix beside a writable one").toBe(false)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}, 120_000)

type FakeConnect = { args: string[]; tokenMode: number; token: string; env: Record<string, string | undefined> }

function fakeTools(scratch: string, linger: "off" | "on" | "refused") {
  const bin = path.join(scratch, "bin")
  mkdirSync(bin, { recursive: true })
  writeFileSync(path.join(bin, "claxedo"), `#!/usr/bin/env node
const fs = require("node:fs")
const [command, ...rest] = process.argv.slice(2)
if (command === "--version") { console.log("9.9.9"); process.exit(0) }
if (command === "--help") process.exit(0)
const tokenFile = rest[rest.indexOf("--token-file") + 1]
fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({
  args: [command, ...rest],
  tokenMode: fs.statSync(tokenFile).mode & 0o777,
  token: fs.readFileSync(tokenFile, "utf8"),
  env: { HOME: process.env.HOME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, CLAXEDO_CONTROL_PLANE_URL: process.env.CLAXEDO_CONTROL_PLANE_URL },
}))
`, { mode: 0o755 })
  writeFileSync(path.join(bin, "loginctl"), `#!/bin/sh
case "$*" in
  *show-user*) [ "${linger}" = on ] && echo yes || echo no ;;
  *enable-linger*) [ "${linger}" = refused ] && exit 1 || exit 0 ;;
esac
`, { mode: 0o755 })
  return bin
}

function runInstall(scratch: string, bin: string, args: readonly string[], env: Record<string, string> = {}) {
  const node = Bun.which("node")
  expect(node, "a Node 24 on PATH, as on CI's unit lanes").toBeTruthy()
  const log = path.join(scratch, "claxedo-connect.json")
  rmSync(log, { force: true })
  const run = spawnSync("sh", [path.join(root, "install.sh"), ...args], {
    cwd: scratch,
    encoding: "utf8",
    env: {
      PATH: `${bin}:${path.dirname(node!)}:/usr/bin:/bin`,
      CLAXEDO_INSTALL_DIR: path.join(scratch, "install"),
      CLAXEDO_CONTROL_PLANE_URL: "https://plane.test",
      CLAXEDO_CLI_MIN_VERSION: "0.0.1",
      FAKE_LOG: log,
      ...env,
    },
  })
  return { run, connected: () => (existsSync(log) ? JSON.parse(readFileSync(log, "utf8")) as FakeConnect : undefined) }
}

function inScratch(body: (scratch: string) => void) {
  const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), "install-sh-")))
  try {
    body(scratch)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

const TOKEN = "chx_inv_2.aHR0cHM6Ly9wbGFuZS50ZXN0.invitation_1.c2VjcmV0"

function passwdEntry() {
  const fields = readFileSync("/etc/passwd", "utf8").split("\n").map((line) => line.split(":")).find((entry) => Number(entry[2]) === process.getuid?.())
  return { username: fields?.[0] ?? "", homedir: fields?.[5] ?? "" }
}

describe.skipIf(process.platform !== "linux")("install.sh with an invitation", () => {
  test("writes the invitation to a file only this user reads and connects with it, the folder and a service, after turning lingering on", () => inScratch((scratch) => {
    const { run, connected } = runInstall(scratch, fakeTools(scratch, "off"), ["--invitation", TOKEN, "--root", "/srv/my app"], { HOME: path.join(scratch, "home"), XDG_RUNTIME_DIR: "/run/user/test" })
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout.split("\n").filter((line) => /^\d\/\d /.test(line))).toEqual(["1/3 Node 24", "2/3 claxedo", "3/3 Connecting this machine"])
    expect(run.stdout).toContain(`    lingering is on for ${passwdEntry().username}, so the service runs while no one is logged in\n`)
    expect(connected()).toEqual({
      args: ["connect", "--token-file", path.join(scratch, "install", "invitation.token"), "--root", "/srv/my app", "--install-service"],
      tokenMode: 0o600,
      token: `${TOKEN}\n`,
      env: { HOME: path.join(scratch, "home"), XDG_RUNTIME_DIR: "/run/user/test", CLAXEDO_CONTROL_PLANE_URL: "https://plane.test" },
    })
  }), 60_000)

  test("names the one command that turns lingering on when it may not, and finds HOME when cloud-init leaves it unset", () => inScratch((scratch) => {
    const { run, connected } = runInstall(scratch, fakeTools(scratch, "refused"), ["--invitation", TOKEN, "--root", "/srv/app"])
    expect(run.status, run.stderr).toBe(0)
    const user = passwdEntry()
    expect(run.stdout).toContain(`    run \`sudo loginctl enable-linger ${user.username}\` so the service runs while no one is logged in\n`)
    expect(connected()?.env.HOME).toBe(user.homedir)
  }), 60_000)

  test("says nothing about lingering when it is already on", () => inScratch((scratch) => {
    const { run, connected } = runInstall(scratch, fakeTools(scratch, "on"), ["--invitation", TOKEN, "--root", "/srv/app"], { HOME: scratch, XDG_RUNTIME_DIR: "/run/user/test" })
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).not.toContain("linger")
    expect(connected()?.args).toContain("--install-service")
  }), 60_000)

  test("refuses in one line, before installing anything, a missing or relative folder, a folder with no invitation, and a code with an invitation", () => inScratch((scratch) => {
    const bin = fakeTools(scratch, "on")
    for (const [args, line] of [
      [["--invitation", TOKEN], "--root names the folder to share; copy the command from Connect a machine… again."],
      [["--invitation", TOKEN, "--root", "srv/app"], "--root must be an absolute path on this machine: srv/app"],
      [["--root", "/srv/app"], "--root goes with --invitation; a pairing code shares the folder the command runs in."],
      [["K7QM4PXD9R2TWB6HJ3NF", "--invitation", TOKEN, "--root", "/srv/app"], "Give a pairing code or an invitation, not both."],
      [["--invitation"], "--invitation needs a value; copy the command from Connect a machine… again."],
    ] as const) {
      const { run, connected } = runInstall(scratch, bin, args, { HOME: scratch })
      expect(run.status, args.join(" ")).toBe(1)
      expect(run.stderr).toBe(`${line}\n`)
      expect(run.stdout).toBe("")
      expect(connected()).toBeUndefined()
    }
  }), 60_000)
})
