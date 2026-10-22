import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { bunStore, installStep, installSteps, type Lock, type Manifest } from "./verify.ts"

const repository = path.resolve(import.meta.dirname, "../..")

/**
 * Every install step a plain `npm install -g` of the CLI runs. A step that
 * compiles needs Python and a C++ toolchain on that person's machine (MSVC on
 * Windows), which nobody installing a CLI has; tree-sitter-powershell, which
 * OpenCode reads only as `.wasm`, is the one that does today. A change to this
 * list is a change to what installing the CLI requires, and is reviewed as one.
 */
const REVIEWED_INSTALL_STEPS: Record<string, string> = {
  "@claxedo/workspace-runtime": "postinstall: node scripts/install-opencode-node.mjs",
  "@google/genai": "preinstall: echo 'preinstall: no-op'",
  "@parcel/watcher": "install: node scripts/build-from-source.js",
  esbuild: "postinstall: node install.js",
  koffi: "install: node ./cnoke.cjs -P . -D src/koffi --prebuild --release",
  "msgpackr-extract": "install: node-gyp-build-optional-packages",
  protobufjs: "postinstall: node scripts/postinstall",
  "tree-sitter-bash": "install: node-gyp-build; prebuilds: darwin-arm64 darwin-x64 linux-arm64 linux-x64 win32-arm64 win32-x64",
  "tree-sitter-powershell": "install: node-gyp-build; no prebuilds, compiles on every platform",
}

test("the CLI's install closure runs only the reviewed install steps", () => {
  const { steps, unreadable } = installSteps({
    roots: ["@claxedo/cli", "@claxedo/workspace-runtime"],
    lock: Bun.JSONC.parse(readFileSync(path.join(repository, "bun.lock"), "utf8")) as Lock,
    workspaceManifest: (directory) => JSON.parse(readFileSync(path.join(repository, directory, "package.json"), "utf8")) as Manifest,
    installed: bunStore(repository),
  })
  expect(unreadable).toEqual([])
  expect(Object.fromEntries(steps.map((entry) => [entry.name, entry.step]))).toEqual(REVIEWED_INSTALL_STEPS)
})

describe("an install step", () => {
  const installed = (manifest: Manifest, bindingGyp = false, prebuilds: string[] = []) => installStep({ manifest, bindingGyp, prebuilds })

  test("is npm's implicit node-gyp rebuild for a binding.gyp with no install script", () => {
    expect(installed({}, true)).toBe("install: node-gyp rebuild (implicit, binding.gyp), compiles on every platform")
    expect(installed({ gypfile: false }, true)).toBeUndefined()
    expect(installed({ scripts: { install: "prebuild-install" } }, true)).toBe("install: prebuild-install")
  })

  test("names the platforms node-gyp-build finds a prebuild for", () => {
    expect(installed({ scripts: { install: "node-gyp-build" } }, true, ["win32-x64", "linux-x64"])).toBe("install: node-gyp-build; prebuilds: linux-x64 win32-x64")
    expect(installed({ scripts: { install: "node-gyp-build" } }, true)).toBe("install: node-gyp-build; no prebuilds, compiles on every platform")
  })

  test("is nothing for a package with no lifecycle script and no binding.gyp", () => {
    expect(installed({ scripts: { build: "tsc", prepare: "husky" } })).toBeUndefined()
  })
})

describe("the install closure", () => {
  const lock: Lock = {
    workspaces: {
      "packages/cli": { name: "@claxedo/cli", dependencies: { "@claxedo/bundled": "workspace:*" } },
      "packages/bundled": { name: "@claxedo/bundled", dependencies: { native: "1.0.0", "win-only": "1.0.0" } },
    },
    packages: {
      "@claxedo/bundled": ["@claxedo/bundled@workspace:packages/bundled"],
      native: ["native@1.0.0", "", { dependencies: { inner: "^2" } }],
      inner: ["inner@1.0.0", "", {}],
      "native/inner": ["inner@2.0.0", "", {}],
      "win-only": ["win-only@1.0.0", "", { os: "win32" }],
    },
  }
  const manifests: Record<string, Manifest> = {
    "packages/cli": {},
    "packages/bundled": { private: true, scripts: { postinstall: "never runs: bundled" } },
  }
  const run = (installed: Record<string, Manifest>) => installSteps({
    roots: ["@claxedo/cli"],
    lock,
    workspaceManifest: (directory) => manifests[directory]!,
    installed: (name, version) => (installed[`${name}@${version}`] ? { manifest: installed[`${name}@${version}`]!, bindingGyp: false, prebuilds: [] } : undefined),
  })

  test("follows a private workspace package's dependencies, not its scripts, and resolves nested versions", () => {
    const { steps, unreadable } = run({
      "native@1.0.0": { scripts: { install: "node-gyp rebuild" } },
      "inner@2.0.0": { scripts: { postinstall: "node nested.js" } },
      "inner@1.0.0": { scripts: { postinstall: "node hoisted.js" } },
    })
    expect(steps).toEqual([
      { name: "inner", step: "postinstall: node nested.js", via: "@claxedo/cli > @claxedo/bundled > native" },
      { name: "native", step: "install: node-gyp rebuild", via: "@claxedo/cli > @claxedo/bundled" },
    ])
    expect(unreadable).toEqual([])
  })

  test("reports a package it cannot read unless the lock restricts it to another platform", () => {
    expect(run({ "native@1.0.0": {} }).unreadable).toEqual(["inner@2.0.0 is in bun.lock but not installed"])
  })
})
