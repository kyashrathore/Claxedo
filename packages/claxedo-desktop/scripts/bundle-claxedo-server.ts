import * as fs from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"

// Native modules cannot be bundled — they ship as the app's only node_modules
// content (see electron-builder.config.ts). Everything else is inlined.
const EXTERNAL = ["@lydell/node-pty", "better-sqlite3", "node-pty", "opencode/node-embed"]

const require = createRequire(import.meta.url)

export async function bundleClaxedoServer(source: string, destination: string) {
  const pending = `${destination}.pending-${process.pid}`
  fs.rmSync(pending, { recursive: true, force: true })

  const result = await Bun.build({
    entrypoints: [source],
    outdir: pending,
    target: "node",
    format: "esm",
    splitting: true,
    minify: {
      syntax: true,
      whitespace: true,
    },
    naming: {
      entry: "index.[ext]",
      chunk: "chunks/[name]-[hash].[ext]",
    },
    external: EXTERNAL,
    plugins: [
      {
        name: "jsonc-parser-esm",
        setup(build) {
          // jsonc-parser's default entry is UMD: Bun cannot see the relative
          // requires hidden inside the UMD factory closure, and they leak as
          // runtime requires that resolve nowhere in a bundled app. The ESM
          // entry is statically analyzable and inlines cleanly.
          build.onResolve({ filter: /^jsonc-parser$/ }, () => ({
            path: require.resolve("jsonc-parser/lib/esm/main.js"),
          }))
        },
      },
    ],
  })

  if (!result.success) {
    fs.rmSync(pending, { recursive: true, force: true })
    throw new AggregateError(result.logs, "Failed to bundle claxedo-server")
  }

  const outputBytes = result.outputs.reduce((total, output) => total + fs.statSync(output.path).size, 0)
  fs.rmSync(destination, { recursive: true, force: true })
  fs.renameSync(pending, destination)
  fs.rmSync(`${destination}.js`, { force: true })

  return {
    entry: path.join(destination, "index.js"),
    outputBytes,
  }
}
