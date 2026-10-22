import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
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
