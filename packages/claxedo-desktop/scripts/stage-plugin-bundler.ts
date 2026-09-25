import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

const PLUGIN_BUILD_DIR = path.resolve(import.meta.dirname, "../../claxedo-plugin-build")

// esbuild's JavaScript API spawns its platform binary, resolved next to its own
// package at runtime; inlined into the server bundle it throws on first use, so
// every live plugin build failed with "Cannot find module 'esbuild'".
export const PLUGIN_BUNDLER_EXTERNALS = ["esbuild"]

function packageDirectory(name: string, from: string): string {
  const require = createRequire(path.join(from, "package.json"))
  return fs.realpathSync(path.dirname(require.resolve(`${name}/package.json`)))
}

export function stagePluginBundler(nodeModules: string, target: { platform: string; arch: string }) {
  const esbuild = packageDirectory("esbuild", PLUGIN_BUILD_DIR)
  const binaryName = `@esbuild/${target.platform}-${target.arch}`
  const packages = [
    { name: "esbuild", source: esbuild },
    { name: binaryName, source: packageDirectory(binaryName, esbuild) },
  ]
  for (const { name, source } of packages) {
    fs.cpSync(source, path.join(nodeModules, name), { recursive: true, dereference: true })
  }
  return packages.map(({ name }) => name)
}
