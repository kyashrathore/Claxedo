import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import { SERVER_ROOT } from "./wrangler-cli"

export const APP_ROOT = path.resolve(SERVER_ROOT, "../claxedo-app")
export const BROWSER_DIRECTORY = path.join(APP_ROOT, "dist")
/** Served beside the app so the deploy can prove the edge serves the build it just published. */
export const BROWSER_BUILD_ATTESTATION = "claxedo-browser-build.json"

async function runBun(args: readonly string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, args, { cwd: APP_ROOT, env, stdio: ["ignore", "inherit", "inherit"] })
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve))
  if (code !== 0) throw new Error(`bun ${args.join(" ")} exited with ${code}`)
}

/** Drop the Pages-only `_redirects` file and upload-only source maps; the assets Worker serves neither. */
export async function prepareBrowserArtifactsForWorkers(directory: string) {
  const root = path.resolve(directory)
  await rm(path.join(root, "_redirects"), { force: true })
  const removeSourceMaps = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) await removeSourceMaps(absolute)
      else if (entry.isFile() && entry.name.endsWith(".map")) await rm(absolute)
    }
  }
  await removeSourceMaps(root)
}

/** A path-and-bytes identity of the built app, excluding the attestation that carries it. */
export async function browserArtifactBuildId(directory: string) {
  const root = path.resolve(directory)
  const files: string[] = []
  const visit = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      if (entry.isSymbolicLink()) throw new Error("browser artifacts must not contain symbolic links")
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join("/"))
      else throw new Error("browser artifacts must contain only directories and regular files")
    }
  }
  await visit(root)
  const selected = files.filter((file) => file !== BROWSER_BUILD_ATTESTATION).sort()
  if (selected.length === 0) throw new Error("browser artifact directory is empty")
  const digest = createHash("sha256")
  for (const relative of selected) {
    const bytes = await readFile(path.join(root, relative))
    digest.update(`path:${Buffer.byteLength(relative)}:${relative}\nbytes:${bytes.byteLength}\n`)
    digest.update(bytes)
    digest.update("\n")
  }
  return `sha256:${digest.digest("hex")}`
}

/** Build the Better Auth browser app against the deployment's API and relay origins, which its CSP names, and stamp it with its build identity. */
export async function buildBrowserApp(apiOrigin: string, relayOrigin: string) {
  await runBun(["run", "build"], { ...process.env, VITE_CLAXEDO_SERVER_URL: apiOrigin, CLAXEDO_RELAY_ORIGINS: relayOrigin })
  await prepareBrowserArtifactsForWorkers(BROWSER_DIRECTORY)
  const browserBuildId = await browserArtifactBuildId(BROWSER_DIRECTORY)
  await writeFile(
    path.join(BROWSER_DIRECTORY, BROWSER_BUILD_ATTESTATION),
    `${JSON.stringify({ schemaVersion: 1, browserBuildId }, null, 2)}\n`,
  )
  return browserBuildId
}
