import type { Plugin } from "esbuild"
import { PLUGIN_RUNTIME_GLOBAL, PLUGIN_RUNTIME_MODULES } from "@claxedo/plugin-api/runtime"

export const RUNTIME_SHIM_NAMESPACE = "claxedo-plugin-runtime"

const SPECIFIER_FILTER = new RegExp(`^(?:${PLUGIN_RUNTIME_MODULES.map((specifier) => specifier.replace(/[/@.-]/g, "\\$&")).join("|")})$`)

export function runtimeShimSource(specifier: string): string {
  const missing = `Cannot load "${specifier}": this bundle must be imported by the Claxedo app, which installs the plugin runtime on globalThis.${PLUGIN_RUNTIME_GLOBAL}`
  return [
    `const runtime = globalThis.${PLUGIN_RUNTIME_GLOBAL};`,
    `const mod = runtime == null ? undefined : runtime[${JSON.stringify(specifier)}];`,
    `if (mod == null) throw new Error(${JSON.stringify(missing)});`,
    `module.exports = mod;`,
    "",
  ].join("\n")
}

export function runtimeShimPlugin(): Plugin {
  return {
    name: "claxedo-plugin-runtime-shims",
    setup(build) {
      build.onResolve({ filter: SPECIFIER_FILTER }, (args) => ({ path: args.path, namespace: RUNTIME_SHIM_NAMESPACE }))
      build.onLoad({ filter: /.*/, namespace: RUNTIME_SHIM_NAMESPACE }, (args) => ({
        contents: runtimeShimSource(args.path),
        loader: "js",
      }))
    },
  }
}
