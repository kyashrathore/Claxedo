import * as fs from "node:fs"
import * as path from "node:path"

const EXTERNAL = [
  "@lydell/node-pty",
  "better-sqlite3",
  "jsonc-parser",
  "node-pty",
]

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
