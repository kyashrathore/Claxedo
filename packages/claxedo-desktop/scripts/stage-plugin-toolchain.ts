import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

const PLUGIN_BUILD_DIR = path.resolve(import.meta.dirname, "../../claxedo-plugin-build")
const PLUGIN_API_DIR = path.resolve(import.meta.dirname, "../../claxedo-plugin-api")

// esbuild's JavaScript API spawns its platform binary, resolved next to its own
// package at runtime; inlined into the server bundle it throws on first use, so
// every live plugin build failed with "Cannot find module 'esbuild'".
export const PLUGIN_TOOLCHAIN_EXTERNALS = ["esbuild"]

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

/**
 * The closure `@claxedo/plugin-build` reaches by Node resolution at runtime,
 * staged as real packages beside the server bundle: esbuild and its binary for
 * a plugin's build, and for `checkPluginApp`'s typecheck the native TypeScript
 * compiler plus the declarations its `paths` name — Solid, the plugin API as
 * source, and zod, which the plugin API's manifest schema imports. Only
 * declarations are staged for the type roots: nothing executes them.
 */
export function stagePluginToolchain(nodeModules: string, target: { platform: string; arch: string }) {
  const esbuild = packageDirectory("esbuild", PLUGIN_BUILD_DIR)
  const esbuildBinary = `@esbuild/${target.platform}-${target.arch}`
  const compiler = `@typescript/typescript-${target.platform}-${target.arch}`
  const packages = [
    { name: "esbuild", source: esbuild, keep: everything },
    { name: esbuildBinary, source: packageDirectory(esbuildBinary, esbuild), keep: everything },
    { name: compiler, source: packageDirectory(compiler, PLUGIN_BUILD_DIR), keep: everything },
    { name: "solid-js", source: packageDirectory("solid-js", PLUGIN_BUILD_DIR), keep: declarations },
    { name: "zod", source: packageDirectory("zod", PLUGIN_API_DIR), keep: declarations },
    { name: "@claxedo/plugin-api", source: PLUGIN_API_DIR, keep: pluginApiSource },
  ]
  for (const { name, source, keep } of packages) copyPackage(source, path.join(nodeModules, name), keep)
  return packages.map(({ name }) => name)
}
