import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { readRecord, readString } from "@claxedo/helpers/readers"
import { runBunBuild } from "../../../script/bun-build"

const PLUGIN_BUILD_DIR = path.resolve(import.meta.dirname, "../../claxedo-plugin-build")
const PLUGIN_API_DIR = path.resolve(import.meta.dirname, "../../claxedo-plugin-api")

export const PLUGIN_TOOLCHAIN_EXTERNALS = ["@claxedo/plugin-build"]

const DECLARATION = /\.d\.[cm]?ts$/

function packageDirectory(name: string, from: string): string {
  const require = createRequire(path.join(from, "package.json"))
  return fs.realpathSync(path.dirname(require.resolve(`${name}/package.json`)))
}

/** Copies the files of `source` that `keep` admits, by their path relative to it; symlinks are followed. */
function copyPackage(source: string, destination: string, keep: (relative: string) => boolean) {
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory)) {
      const file = path.join(directory, entry)
      const relative = path.relative(source, file)
      if (fs.statSync(file).isDirectory()) {
        if (entry !== "node_modules") walk(file)
        continue
      }
      if (!keep(relative)) continue
      const target = path.join(destination, relative)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(file, target)
    }
  }
  walk(source)
}

const everything = () => true
const declarations = (relative: string) => relative === "package.json" || DECLARATION.test(relative)
const pluginApiSource = (relative: string) =>
  relative === "package.json" || (relative.startsWith(`src${path.sep}`) && relative.endsWith(".ts") && !relative.endsWith(".test.ts"))

/** Keep both the resolver and its dependencies inside the plugin-build package. */
export async function stagePluginToolchain(nodeModules: string, target: { platform: string; arch: string }) {
  const root = path.join(nodeModules, "@claxedo/plugin-build")
  const dependencies = path.join(root, "node_modules")
  fs.rmSync(root, { recursive: true, force: true })
  // The daemon bundle keeps every subpath of the package external, so each
  // source export needs its own staged file.
  const manifest: unknown = JSON.parse(fs.readFileSync(path.join(PLUGIN_BUILD_DIR, "package.json"), "utf8"))
  const sourceExports = Object.entries(readRecord(manifest, "exports") ?? {}).map(([subpath, entry]) => {
    const source = readString(entry, "default")
    if (!source) throw new Error(`@claxedo/plugin-build export ${subpath} names no default file`)
    return { subpath, source }
  })
  await runBunBuild("Failed to bundle plugin toolchain", {
    entrypoints: sourceExports.map(({ source }) => path.join(PLUGIN_BUILD_DIR, source)),
    outdir: root,
    target: "node",
    format: "esm",
    naming: "[name].js",
    // esbuild locates and spawns its binary relative to its own package.
    external: ["esbuild"],
  })
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "@claxedo/plugin-build",
    type: "module",
    exports: Object.fromEntries(sourceExports.map(({ subpath, source }) => [subpath, `./${path.basename(source, ".ts")}.js`])),
  }))
  const esbuild = packageDirectory("esbuild", PLUGIN_BUILD_DIR)
  const esbuildBinary = `@esbuild/${target.platform}-${target.arch}`
  const compiler = `@typescript/typescript-${target.platform}-${target.arch}`
  const packages = [
    { name: "esbuild", source: esbuild, keep: everything },
    { name: esbuildBinary, source: packageDirectory(esbuildBinary, esbuild), keep: everything },
    { name: compiler, source: packageDirectory(compiler, PLUGIN_BUILD_DIR), keep: everything },
    { name: "solid-js", source: packageDirectory("solid-js", PLUGIN_BUILD_DIR), keep: declarations },
    { name: "zod", source: packageDirectory("zod", PLUGIN_API_DIR), keep: declarations },
    { name: "@claxedo/agent-runtime-contract", source: packageDirectory("@claxedo/agent-runtime-contract", PLUGIN_API_DIR), keep: declarations },
    { name: "@claxedo/plugin-api", source: PLUGIN_API_DIR, keep: pluginApiSource },
  ]
  for (const { name, source, keep } of packages) copyPackage(source, path.join(dependencies, name), keep)
  return packages.map(({ name }) => name)
}
