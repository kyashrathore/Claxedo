import path from "node:path"
import { build } from "esbuild"
import { PI_RUNNER_FILE } from "../src/transports/pi-durable/runner-file"

export async function bundlePiRunner(outdir: string): Promise<{ file: string }> {
  const file = path.join(outdir, PI_RUNNER_FILE)
  await build({
    entryPoints: [path.resolve(import.meta.dirname, "../src/transports/pi-durable/runner-child.ts")],
    outfile: file,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "warning",
  })
  return { file }
}
