import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { stageOpenCodeSdk } from "./stage-opencode-sdk"

test("staged SDK packages preserve aliases, version isolation, and assets without checkout links", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-sdk-stage-"))
  const owner = path.join(root, "owner")
  function pkg(relative: string, name: string, version: string, dependencies = {}, code = "") {
    const directory = path.join(owner, "node_modules", relative)
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name, version, type: "module", exports: "./index.js", dependencies }))
    fs.writeFileSync(path.join(directory, "index.js"), code)
    return directory
  }
  try {
    const sdk = pkg("@opencode-ai/sdk", "@opencode-ai/sdk", "1", { a: "1", renamed: "npm:original@1", shared: "2" },
      'import a from "a"; import renamed from "renamed"; import shared from "shared"; export default [a, renamed, shared]')
    fs.writeFileSync(path.join(sdk, "data.wasm"), "runtime asset")
    fs.writeFileSync(path.join(sdk, "index.js.map"), "{}")
    fs.writeFileSync(path.join(sdk, "index.d.ts"), "export {}")
    pkg("a", "a", "1", { shared: "1" }, 'import shared from "shared"; export default shared')
    pkg("a/node_modules/shared", "shared", "1", {}, 'export default "v1"')
    pkg("shared", "shared", "2", {}, 'export default "v2"')
    pkg("renamed", "original", "1", {}, 'export default "alias"')
    pkg("koffi", "koffi", "1", {}, "export default {}")
    const output = path.join(root, "output")
    stageOpenCodeSdk(path.join(output, "node_modules"), undefined, owner)
    fs.rmSync(owner, { recursive: true })
    const entry = path.join(output, "probe.mjs")
    fs.writeFileSync(entry, 'import value from "@opencode-ai/sdk"; console.log(JSON.stringify(value))')
    const result = execFileSync("node", [entry], { encoding: "utf8" }).trim()
    expect(JSON.parse(result)).toEqual(["v1", "alias", "v2"])
    const staged = path.join(output, "node_modules/@opencode-ai/sdk")
    expect(fs.readFileSync(path.join(staged, "data.wasm"), "utf8")).toBe("runtime asset")
    expect(fs.existsSync(path.join(staged, "index.js.map"))).toBe(false)
    expect(fs.existsSync(path.join(staged, "index.d.ts"))).toBe(false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test("cross-target staging fails when the required native package is missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-sdk-native-stage-"))
  try {
    for (const name of ["@opencode-ai/sdk", "koffi"]) {
      const directory = path.join(root, "node_modules", name)
      fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({
        name, version: "1",
        ...(name === "koffi" ? { optionalDependencies: { "@koromix/koffi-linux-x64": "1" } } : {}),
      }))
    }
    expect(() => stageOpenCodeSdk(path.join(root, "output/node_modules"), { platform: "linux", arch: "x64" }, root))
      .toThrow("Missing SDK runtime dependency @koromix/koffi-linux-x64")
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
