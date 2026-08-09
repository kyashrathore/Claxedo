import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

export const HOST_CONNECTOR_CHILD_MANIFEST_SCHEMA = "claxedo.host-connector-child/v1"

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

/** Resolve and verify the one reviewed child executable. No caller supplies a path. */
export function verifyHostConnectorChildArtifact(resourceDir: string): string {
  const manifestPath = join(resourceDir, "manifest.json")
  if (!existsSync(manifestPath)) {
    throw new Error(`Host Connector child manifest was not found at ${manifestPath}. Rebuild the desktop app and try again.`)
  }

  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  } catch {
    throw new Error(`Host Connector child manifest could not be parsed at ${manifestPath}`)
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new Error(`Host Connector child manifest has the wrong shape at ${manifestPath}`)
  }
  const value = manifest as Record<string, unknown>
  if (
    value.schema !== HOST_CONNECTOR_CHILD_MANIFEST_SCHEMA ||
    value.entry !== "index.js" ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    Object.keys(value).sort().join(",") !== "entry,schema,sha256"
  ) {
    throw new Error(`Host Connector child manifest failed validation at ${manifestPath}`)
  }

  const entry = join(resourceDir, "index.js")
  if (!existsSync(entry)) throw new Error(`Host Connector child executable was not found at ${entry}`)
  if (sha256(entry) !== value.sha256) throw new Error(`Host Connector child fingerprint mismatch at ${entry}`)
  return entry
}

export function hostConnectorChildResourceDir(input: {
  packaged: boolean
  mainDir: string
  resourcesPath: string
}): string {
  return input.packaged
    ? join(input.resourcesPath, "host-connector")
    : join(input.mainDir, "../../resources/host-connector")
}
