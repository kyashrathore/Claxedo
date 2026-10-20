import fs from "node:fs/promises"
import path from "node:path"
import { PluginBuildError } from "./errors"
import { buildPluginRelease, signPluginRelease } from "./release"

const [rootDir, registryDir] = process.argv.slice(2)
const signingKey = process.env.CLAXEDO_APP_PLUGIN_REGISTRY_SIGNING_KEY
const keyId = process.env.CLAXEDO_APP_PLUGIN_REGISTRY_KEY_ID
if (!rootDir || !registryDir || !signingKey || !keyId) {
  console.error("usage: CLAXEDO_APP_PLUGIN_REGISTRY_SIGNING_KEY=<base64 PKCS#8 Ed25519> CLAXEDO_APP_PLUGIN_REGISTRY_KEY_ID=<id> bun release-cli.ts <plugin package directory> <registry directory>")
  process.exit(2)
}

try {
  const built = await buildPluginRelease({ rootDir })
  const key = await crypto.subtle.importKey("pkcs8", Buffer.from(signingKey, "base64"), { name: "Ed25519" }, false, ["sign"])
  const signed = await signPluginRelease(built.release, key, keyId)
  const releaseFile = path.join(registryDir, "releases", built.release.id, `${built.release.version}.json`)
  await fs.mkdir(path.dirname(releaseFile), { recursive: true })
  await fs.mkdir(path.join(registryDir, "blobs"), { recursive: true })
  for (const [sha256, code] of built.blobs) await fs.writeFile(path.join(registryDir, "blobs", sha256), code)
  await fs.writeFile(releaseFile, `${JSON.stringify(signed, null, 2)}\n`)
  console.log(releaseFile)
} catch (error) {
  if (!(error instanceof PluginBuildError)) throw error
  for (const message of error.messages) console.error(message)
  process.exit(1)
}
