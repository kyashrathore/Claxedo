import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const INSTALL_WRITTEN = new Set(["./node_modules", "./package-lock.json"])

function files(root: string, dir = "."): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${dir}/${entry.name}`
    if (INSTALL_WRITTEN.has(relative)) return []
    if (entry.isDirectory()) return files(root, relative)
    return entry.isFile() ? [relative] : []
  })
}

/**
 * The digest of the bundle directory an image copies to /opt/workspace-runtime,
 * in the form the sandbox Worker's `RUNTIME_DIGEST_SCRIPT` recomputes inside a
 * container: `sha256sum` lines for every file by byte-sorted path, hashed.
 * What `npm install` writes there afterwards is left out.
 */
export function runtimeDigest(root: string) {
  const lines = files(root)
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map((file) => `${createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex")}  ${file}\n`)
  return createHash("sha256").update(lines.join("")).digest("hex")
}
