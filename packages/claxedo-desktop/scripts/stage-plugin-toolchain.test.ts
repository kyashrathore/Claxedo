import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { PLUGIN_TOOLCHAIN_EXTERNALS, stagePluginToolchain } from "./stage-plugin-toolchain"

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-plugin-toolchain-"))
const CHUNKS = path.join(OUT, "chunks")
const NODE_MODULES = path.join(OUT, "node_modules")
const PLUGIN_BUILD_ENTRY = path.resolve(import.meta.dirname, "../../claxedo-plugin-build/src/index.ts")

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
  stagePluginToolchain(NODE_MODULES, { platform: process.platform, arch: process.arch })
  const built = await Bun.build({
    entrypoints: [PLUGIN_BUILD_ENTRY],
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
  const compiler = path.join(NODE_MODULES, `@typescript/typescript-${process.platform}-${process.arch}`, "lib", process.platform === "win32" ? "tsc.exe" : "tsc")
  expect(fs.statSync(compiler).isFile()).toBe(true)
  for (const root of ["solid-js", "zod"]) {
    const staged = files(path.join(NODE_MODULES, root))
    expect(staged).toContain("package.json")
    expect(staged.filter((file) => file !== "package.json").every((file) => /\.d\.[cm]?ts$/.test(file))).toBe(true)
  }
  const pluginApi = files(path.join(NODE_MODULES, "@claxedo/plugin-api"))
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
