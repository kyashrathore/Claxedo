import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { PLUGIN_TOOLCHAIN_EXTERNALS, stagePluginToolchain } from "./stage-plugin-toolchain"

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-plugin-toolchain-"))
const CHUNKS = path.join(OUT, "chunks")
const NODE_MODULES = path.join(OUT, "node_modules")
const TOOLCHAIN = path.join(NODE_MODULES, "@claxedo/plugin-build")
const DEPENDENCIES = path.join(TOOLCHAIN, "node_modules")
const SDK_ZOD = JSON.stringify({ name: "zod", version: "4.1.8" })

const APP = `import { definePlugin } from "@claxedo/plugin-api"

export default definePlugin({
  activate(api) {
    api.sidebar.item({ id: "notes", label: "Notes", pageId: "notes" })
  },
})
`

type Check = { ok: boolean; hash?: string; diagnostics: Array<{ stage: string; code?: string; file?: string; message: string }> }

function writePlugin(name: string, app: string) {
  const dir = path.join(OUT, "plugins", name)
  fs.mkdirSync(path.join(dir, "src"), { recursive: true })
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: `claxedo-plugin-${name}`, version: "0.1.0", claxedo: { id: name, name: "Notes", version: "0.1.0", app: "./src/app.tsx" } }),
  )
  fs.writeFileSync(path.join(dir, "src", "app.tsx"), app)
  return dir
}

/** Runs the bundled toolchain under Node from the staged layout, as the packaged daemon does. */
async function checkFromStagedLayout(rootDir: string): Promise<Check> {
  const { NODE_PATH: _ignored, ...env } = process.env
  const child = Bun.spawn(["node", path.join(CHUNKS, "probe.mjs"), rootDir], { cwd: OUT, env, stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(exitCode, stderr).toBe(0)
  return JSON.parse(stdout) as Check
}

function files(directory: string): string[] {
  return fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)))
}

beforeAll(async () => {
  fs.mkdirSync(CHUNKS, { recursive: true })
  for (const name of ["zod", "solid-js", "esbuild", `@typescript/typescript-${process.platform}-${process.arch}`, "@claxedo/plugin-api"]) {
    const directory = path.join(NODE_MODULES, name)
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, "package.json"), name === "zod" ? SDK_ZOD : JSON.stringify({ name, version: "0.0.0", exports: "./missing.js" }))
  }
  await stagePluginToolchain(NODE_MODULES, { platform: process.platform, arch: process.arch })
  const entry = path.join(OUT, "caller.ts")
  fs.writeFileSync(entry, 'export { checkPluginApp } from "@claxedo/plugin-build"')
  const built = await Bun.build({
    entrypoints: [entry],
    outdir: CHUNKS,
    target: "node",
    format: "esm",
    external: PLUGIN_TOOLCHAIN_EXTERNALS,
    naming: "toolchain.[ext]",
  })
  if (!built.success) throw new Error(built.logs.map(String).join("\n"))
  fs.writeFileSync(
    path.join(CHUNKS, "probe.mjs"),
    'import { checkPluginApp } from "./toolchain.js"\nprocess.stdout.write(JSON.stringify(await checkPluginApp({ rootDir: process.argv[2] })))\n',
  )
}, 120_000)

afterAll(() => {
  fs.rmSync(OUT, { recursive: true, force: true })
})

test("the staged closure holds the compiler binary and only declarations for the type roots", () => {
  const compiler = path.join(DEPENDENCIES, `@typescript/typescript-${process.platform}-${process.arch}`, "lib", process.platform === "win32" ? "tsc.exe" : "tsc")
  expect(fs.statSync(compiler).isFile()).toBe(true)
  for (const root of ["solid-js", "zod"]) {
    const staged = files(path.join(DEPENDENCIES, root))
    expect(staged).toContain("package.json")
    expect(staged.filter((file) => file !== "package.json").every((file) => /\.d\.[cm]?ts$/.test(file))).toBe(true)
  }
  const pluginApi = files(path.join(DEPENDENCIES, "@claxedo/plugin-api"))
  expect(pluginApi).toContain(path.join("src", "index.ts"))
  expect(pluginApi.some((file) => file.endsWith(".test.ts"))).toBe(false)
})

test("a bundled daemon typechecks and builds a plugin from the staged closure alone", async () => {
  const green = await checkFromStagedLayout(writePlugin("green", APP))
  expect(green.diagnostics).toEqual([])
  expect(green.ok).toBe(true)
  expect(green.hash).toMatch(/^[0-9a-f]{16}$/)

  const red = await checkFromStagedLayout(writePlugin("red", APP.replace('label: "Notes"', "label: 42")))
  expect(red.ok).toBe(false)
  expect(red.diagnostics).toEqual([expect.objectContaining({ stage: "typecheck", file: path.join("src", "app.tsx"), code: "TS2322" })])
}, 120_000)

test("staging preserves the daemon inventory and resolution stays inside each owner", () => {
  expect(fs.readFileSync(path.join(NODE_MODULES, "zod/package.json"), "utf8")).toBe(SDK_ZOD)
  const daemon = createRequire(path.join(CHUNKS, "probe.mjs"))
  const toolchain = createRequire(daemon.resolve("@claxedo/plugin-build"))
  const api = createRequire(toolchain.resolve("@claxedo/plugin-api"))
  expect(fs.realpathSync(daemon.resolve("zod/package.json"))).toBe(fs.realpathSync(path.join(NODE_MODULES, "zod/package.json")))
  expect(fs.realpathSync(api.resolve("zod/package.json"))).toBe(fs.realpathSync(path.join(DEPENDENCIES, "zod/package.json")))
  expect(JSON.parse(fs.readFileSync(api.resolve("zod/package.json"), "utf8")).version).toBe("4.4.3")
  expect(fs.realpathSync(toolchain.resolve("esbuild"))).toStartWith(fs.realpathSync(path.join(DEPENDENCIES, "esbuild")))
})

test("the plugin API source requires zod declarations even with skipLibCheck", async () => {
  const zod = path.join(DEPENDENCIES, "zod")
  fs.renameSync(zod, `${zod}.hidden`)
  try {
    const checked = await checkFromStagedLayout(writePlugin("missing-zod", APP))
    expect(checked.ok).toBe(false)
    expect(checked.diagnostics.some((diagnostic) => diagnostic.message.includes("zod"))).toBe(true)
  } finally {
    fs.renameSync(`${zod}.hidden`, zod)
  }
}, 120_000)
