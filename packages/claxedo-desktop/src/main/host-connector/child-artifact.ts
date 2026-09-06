import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { isRecord } from "../../shared/json-read"

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
  if (!isRecord(manifest)) {
    throw new Error(`Host Connector child manifest has the wrong shape at ${manifestPath}`)
  }
  if (
    manifest.schema !== HOST_CONNECTOR_CHILD_MANIFEST_SCHEMA ||
    manifest.entry !== "index.js" ||
    typeof manifest.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
    Object.keys(manifest).sort().join(",") !== "entry,schema,sha256"
  ) {
    throw new Error(`Host Connector child manifest failed validation at ${manifestPath}`)
  }

  const entry = join(resourceDir, "index.js")
  if (!existsSync(entry)) throw new Error(`Host Connector child executable was not found at ${entry}`)
  if (sha256(entry) !== manifest.sha256) throw new Error(`Host Connector child fingerprint mismatch at ${entry}`)
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
