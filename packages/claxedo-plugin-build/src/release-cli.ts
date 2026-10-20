import fs from "node:fs/promises"
import path from "node:path"
import { PLUGIN_INDEX_DESCRIPTION_MAX_LENGTH, signedPluginIndexSchema, pluginIndexSchema, type PluginIndex } from "@claxedo/plugin-api/registry-index"
import { PluginBuildError } from "./errors"
import { PLUGIN_PACKAGE_FILE } from "./manifest-file"
import { buildPluginRelease, indexWithRelease, signPluginIndex, signPluginRelease } from "./release"

const [rootDir, registryDir] = process.argv.slice(2)
const signingKey = process.env.CLAXEDO_APP_PLUGIN_REGISTRY_SIGNING_KEY
const keyId = process.env.CLAXEDO_APP_PLUGIN_REGISTRY_KEY_ID
if (!rootDir || !registryDir || !signingKey || !keyId) {
  console.error("usage: CLAXEDO_APP_PLUGIN_REGISTRY_SIGNING_KEY=<base64 PKCS#8 Ed25519> CLAXEDO_APP_PLUGIN_REGISTRY_KEY_ID=<id> bun release-cli.ts <plugin package directory> <registry directory>")
  process.exit(2)
}

async function packageDescription(directory: string): Promise<string | undefined> {
  const packageJson: unknown = JSON.parse(await fs.readFile(path.join(directory, PLUGIN_PACKAGE_FILE), "utf8"))
  const description = typeof packageJson === "object" && packageJson !== null ? Reflect.get(packageJson, "description") : undefined
  return typeof description === "string" && description.trim() ? description.trim().slice(0, PLUGIN_INDEX_DESCRIPTION_MAX_LENGTH) : undefined
}

async function publishedIndex(file: string): Promise<PluginIndex | undefined> {
  let text: string
  try {
    text = await fs.readFile(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  return pluginIndexSchema.parse(signedPluginIndexSchema.parse(JSON.parse(text)).index)
}

try {
  const built = await buildPluginRelease({ rootDir })
  const key = await crypto.subtle.importKey("pkcs8", Buffer.from(signingKey, "base64"), { name: "Ed25519" }, false, ["sign"])
  const signed = await signPluginRelease(built.release, key, keyId)
  const releaseFile = path.join(registryDir, "releases", built.release.id, `${built.release.version}.json`)
  const indexFile = path.join(registryDir, "index.json")
  await fs.mkdir(path.dirname(releaseFile), { recursive: true })
  await fs.mkdir(path.join(registryDir, "blobs"), { recursive: true })
  for (const [sha256, code] of built.blobs) await fs.writeFile(path.join(registryDir, "blobs", sha256), code)
  await fs.writeFile(releaseFile, `${JSON.stringify(signed, null, 2)}\n`)
  const index = indexWithRelease(await publishedIndex(indexFile), built.release, await packageDescription(rootDir), new Date())
  await fs.writeFile(indexFile, `${JSON.stringify(await signPluginIndex(index, key, keyId), null, 2)}\n`)
  console.log(releaseFile)
} catch (error) {
  if (!(error instanceof PluginBuildError)) throw error
  for (const message of error.messages) console.error(message)
  process.exit(1)
}
