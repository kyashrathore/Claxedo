import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

import { resolveChannel, type Channel } from "./utils"
import { MAIN_RENDERER_DOCUMENT } from "../src/main/navigation-guard"

export type Spec = {
  file: string
  input: string[]
  match: Array<[string, string]>
  output: string[]
  root: string
}

type Manifest = {
  built_at: string
  channel: Channel
  source_commit: string
  input: Record<string, string>
  output: Record<string, string>
}

const ROOT = path.resolve(import.meta.dir, "..")

function rel(root: string, file: string) {
  return path.relative(root, file).replaceAll("\\", "/")
}

function hash(file: string) {
  const out = createHash("sha256")
  out.update(fs.readFileSync(file))
  return out.digest("hex")
}

function walk(root: string, entry: string) {
  const file = path.resolve(root, entry)
  if (!fs.existsSync(file)) {
    throw new Error(`missing path: ${entry}`)
  }
  if (!fs.statSync(file).isDirectory()) {
    return [rel(root, file)]
  }

  return fs.readdirSync(file, { withFileTypes: true })
    .flatMap((item) => {
      const next = path.join(file, item.name)
      if (item.isDirectory()) {
        return walk(root, rel(root, next))
      }
      if (item.isFile()) {
        return [rel(root, next)]
      }
      return []
    })
    .sort()
}

function snapshot(root: string, list: string[]) {
  return list
    .flatMap((entry) => walk(root, entry))
    .sort()
    .reduce<Record<string, string>>((out, entry) => {
      out[entry] = hash(path.resolve(root, entry))
      return out
    }, {})
}

function compare(kind: string, expected: Record<string, string>, actual: Record<string, string>) {
  const bad = Object.keys(expected).flatMap((entry) => {
    if (!(entry in actual)) return [`${kind} missing: ${entry}`]
    if (expected[entry] !== actual[entry]) return [`${kind} changed: ${entry}`]
    return []
  })
  const extra = Object.keys(actual)
    .filter((entry) => !(entry in expected))
    .map((entry) => `${kind} unexpected: ${entry}`)

  if (bad.length === 0 && extra.length === 0) return
  throw new Error([...bad, ...extra].join("\n"))
}

function checkPairs(output: Record<string, string>, match: Array<[string, string]>) {
  const bad = match.flatMap(([a, b]) => {
    if (!(a in output)) return [`output missing: ${a}`]
    if (!(b in output)) return [`output missing: ${b}`]
    if (output[a] === output[b]) return []
    return [`output mismatch: ${a} != ${b}`]
  })

  if (bad.length === 0) return
  throw new Error(bad.join("\n"))
}

function read(spec: Spec) {
  if (!fs.existsSync(spec.file)) {
    throw new Error(`missing build contract: ${rel(spec.root, spec.file)}`)
  }
  return JSON.parse(fs.readFileSync(spec.file, "utf8")) as Manifest
}

export function spec(root = ROOT): Spec {
  const input = [
    "electron-builder.config.ts",
    "electron.vite.config.ts",
    "icons",
    "package.json",
    "scripts/build.ts",
    "scripts/build-memory-impact-helper.ts",
    "scripts/bundle-claxedo-server.ts",
    "scripts/claxedo-server-entry.ts",
    "scripts/claxedo-engine-worker-entry.ts",
    "scripts/claxedo-engine-worker-policy.ts",
    "scripts/claxedo-server-startup.ts",
    "scripts/copy-bundles.ts",
    "scripts/contract.ts",
    "scripts/finalize-latest-yml.ts",
    "scripts/bundle-host-connector.ts",
    "scripts/host-connector-entry.ts",
    // How the desktop resolves its server, and what the packaged app may
    // contain: both decide the artifact, so both belong in its fingerprint.
    "scripts/local-server.ts",
    "scripts/package-structure.ts",
    "scripts/product-boundary-manifests.ts",
    "scripts/package.ts",
    "scripts/prepare.ts",
    "scripts/prebuild.ts",
    "scripts/predev.ts",
    "scripts/target-platform.ts",
    "scripts/utils.ts",
    "scripts/verify-package-contents.ts",
    "vite.renderer.ts",
    "src",
    "src/main/host-connector/child-artifact.ts",
    "src/main/host-connector/child-protocol.ts",
    "src/main/host-connector/child-supervisor.ts",
    "src/main/host-connector/electron-child.ts",
    "src/main/host-connector/identity-store.ts",
    "../agent-event-runtime/package.json",
    "../agent-event-runtime/src",
    "../agent-sdk-runtime/package.json",
    "../agent-sdk-runtime/src",
    "../app/package.json",
    "../app/src",
    "../claxedo-app/package.json",
    "../claxedo-app/public",
    "../claxedo-app/src",
    // What the desktop actually bundles: the local product and the shared core
    // beneath it. `claxedo-server` is the hosted/self-hosted product and no
    // longer feeds this artifact.
    "../claxedo-local-server/package.json",
    "../claxedo-local-server/src",
    "../claxedo-server-core/package.json",
    "../claxedo-server-core/src",
    // The optional Host Connector child. It is fingerprinted SEPARATELY from
    // the server and renderer closures — neither imports it — but it ships in
    // the same artifact, so a change to it must invalidate this contract
    // rather than pass unnoticed.
    "../claxedo-host-connector/package.json",
    "../claxedo-host-connector/src",
    "../opencode/package.json",
    "../opencode/src",
    "../sdk/js/package.json",
    "../sdk/js/src",
    "../sdk-next/package.json",
    "../sdk-next/src",
    "../ui/package.json",
    "../ui/src",
    "../workspace-runtime/package.json",
    "../workspace-runtime/src",
    "../workspace-runtime/templates",
  ].filter((entry) => fs.existsSync(path.resolve(root, entry)))

  return {
    root,
    file: path.join(root, "dist/.build-contract.json"),
    input,
    output: [
      "out/main/claxedo-server",
      "out/main/claxedo-engine-worker",
      "out/main/index.js",
      "out/preload/index.cjs",
      "out/preload/browser-preload.cjs",
      // Every build starts from the local shell. Hosted capability remains a
      // separately fingerprinted dynamic contribution, never a second HTML
      // document selected by an environment-dependent mode.
      `out/renderer/${MAIN_RENDERER_DOCUMENT}`,
      "out/renderer/loading.html",
      "out/product-boundary",
      "out/templates",
      "resources/claxedo-server",
      "resources/host-connector",
      "resources/claxedo-engine-worker",
      "resources/icons/128x128@2x.png",
      "resources/icons/icon.icns",
      "resources/icons/icon.ico",
    ],
    match: [
      ["out/main/claxedo-server/index.js", "resources/claxedo-server/index.js"],
      ["out/main/claxedo-engine-worker/index.js", "resources/claxedo-engine-worker/index.js"],
    ],
  }
}

function validateSourceCommit(value: string) {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(`invalid build source commit: ${value || "empty"}`)
  return value
}

function resolveSourceCommit(root: string) {
  const supplied = process.env.CLAXEDO_BUILD_SOURCE_COMMIT ?? process.env.GITHUB_SHA
  if (supplied) return validateSourceCommit(supplied.trim())
  const result = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) throw new Error(`could not resolve build source commit: ${result.stderr.toString().trim()}`)
  return validateSourceCommit(result.stdout.toString().trim())
}

export function write(specArg = spec(), channel = resolveChannel(), sourceCommit = resolveSourceCommit(specArg.root)) {
  const input = snapshot(specArg.root, specArg.input)
  const output = snapshot(specArg.root, specArg.output)
  checkPairs(output, specArg.match)

  const data: Manifest = {
    built_at: new Date().toISOString(),
    channel,
    source_commit: validateSourceCommit(sourceCommit),
    input,
    output,
  }

  fs.mkdirSync(path.dirname(specArg.file), { recursive: true })
  fs.writeFileSync(specArg.file, JSON.stringify(data, null, 2) + "\n")

  return data
}

export function verify(specArg = spec(), channel = resolveChannel(), sourceCommit = resolveSourceCommit(specArg.root)) {
  const saved = read(specArg)
  if (saved.channel !== channel) {
    throw new Error(`build contract channel mismatch: expected ${channel}, got ${saved.channel}`)
  }
  if (saved.source_commit !== validateSourceCommit(sourceCommit)) {
    throw new Error(`build contract source commit mismatch: expected ${sourceCommit}, got ${saved.source_commit}`)
  }

  const input = snapshot(specArg.root, specArg.input)
  const output = snapshot(specArg.root, specArg.output)
  compare("input", saved.input, input)
  compare("output", saved.output, output)
  checkPairs(output, specArg.match)

  return saved
}
