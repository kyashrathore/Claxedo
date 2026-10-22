import { expect, test } from "bun:test"
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
