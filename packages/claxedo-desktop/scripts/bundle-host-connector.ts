import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

export const HOST_CONNECTOR_CHILD_MANIFEST_SCHEMA = "claxedo.host-connector-child/v1"

const PACKAGE_DIR = resolve(import.meta.dir, "..")
const DEFAULT_ENTRY = resolve(import.meta.dir, "host-connector-entry.ts")
const DEFAULT_OUTPUT_DIR = resolve(PACKAGE_DIR, "resources/host-connector")

export type HostConnectorChildManifest = {
  schema: typeof HOST_CONNECTOR_CHILD_MANIFEST_SCHEMA
  entry: "index.js"
  sha256: string
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

/** Build the optional child as one self-contained, independently hashed file. */
export async function bundleHostConnector(input: { entry?: string; outputDir?: string } = {}) {
  const entry = input.entry ?? DEFAULT_ENTRY
  const outputDir = input.outputDir ?? DEFAULT_OUTPUT_DIR
  const output = join(outputDir, "index.js")
  const manifestPath = join(outputDir, "manifest.json")

  if (!existsSync(entry)) throw new Error(`Host Connector child entry was not found at ${entry}`)
  rmSync(outputDir, { recursive: true, force: true })
  mkdirSync(outputDir, { recursive: true })

  const built = await Bun.build({
    entrypoints: [entry],
    outdir: outputDir,
    naming: "index.js",
    target: "node",
    format: "esm",
    splitting: false,
    sourcemap: "none",
    minify: false,
  })
  if (!built.success) {
    throw new AggregateError(built.logs, "Host Connector child bundle failed")
  }
  if (!existsSync(output)) throw new Error(`Host Connector child bundle emitted no ${output}`)

  const manifest: HostConnectorChildManifest = {
    schema: HOST_CONNECTOR_CHILD_MANIFEST_SCHEMA,
    entry: "index.js",
    sha256: sha256(output),
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return { output, manifestPath, manifest }
}

if (import.meta.main) {
  const bundled = await bundleHostConnector()
  console.log(`[host-connector] bundled ${bundled.output} (${bundled.manifest.sha256})`)
}
