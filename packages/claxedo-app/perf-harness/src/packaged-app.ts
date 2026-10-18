import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { access } from "node:fs/promises"
import path from "node:path"

export type PackagedApp = {
  executable: string
  resources: string
  asar: string
  serverEntry: string
  serverCompileCache: string
}

export function packagedApp(executable: string): PackagedApp {
  const resources = process.platform === "darwin"
    ? path.resolve(path.dirname(executable), "..", "Resources")
    : path.resolve(path.dirname(executable), "resources")
  const asar = path.join(resources, "app.asar")
  return {
    executable,
    resources,
    asar,
    serverEntry: path.join(asar, "out", "main", "claxedo-server", "index.js"),
    serverCompileCache: path.join(resources, "claxedo-server-compile-cache"),
  }
}

export function configuredExecutable() {
  const configured = process.env.CLAXEDO_BENCHMARK_EXECUTABLE?.trim()
  if (!configured) throw new Error("CLAXEDO_BENCHMARK_EXECUTABLE must point at the packaged Claxedo desktop executable")
  return path.resolve(configured)
}

export async function requirePackagedApp(executable: string) {
  const app = packagedApp(executable)
  await access(app.executable)
  await access(app.asar)
  return app
}

async function hashFile(hash: ReturnType<typeof createHash>, file: string) {
  for await (const chunk of createReadStream(file)) {
    if (!Buffer.isBuffer(chunk)) throw new Error(`Claxedo read a non-binary chunk from ${file}`)
    hash.update(chunk)
  }
}

export async function sha256Files(files: string[]) {
  const hash = createHash("sha256")
  for (const file of files) await hashFile(hash, file)
  return hash.digest("hex")
}
