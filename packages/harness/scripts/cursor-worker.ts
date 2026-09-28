import { builtinModules } from "node:module"
import path from "node:path"
import { build } from "esbuild"
import { CURSOR_WORKER_FILE } from "../src/transports/cursor-sdk/worker-file"

const builtins = new Set(builtinModules)

function packageName(specifier: string): string {
  return specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/")
}

export async function bundleCursorWorker(outdir: string): Promise<{ file: string; packages: string[] }> {
  const file = path.join(outdir, CURSOR_WORKER_FILE)
  const packages = new Set<string>()
  await build({
    entryPoints: [path.resolve(import.meta.dirname, "../src/transports/cursor-sdk/host.ts")],
    outfile: file,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "warning",
    plugins: [{
      name: "cursor-worker-npm-external",
      setup(worker) {
        worker.onResolve({ filter: /^[^./]/ }, (args) => {
          if (args.path.startsWith("@claxedo/") || args.path.startsWith("node:") || builtins.has(args.path)) return undefined
          packages.add(packageName(args.path))
          return { path: args.path, external: true }
        })
      },
    }],
  })
  return { file, packages: [...packages].sort() }
}
