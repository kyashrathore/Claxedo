import crypto from "crypto"
import fs from "fs/promises"
import path from "path"

// State and target-config files are read back on every lifecycle command and
// treated as the source of truth for what may be deleted, so a torn write must
// never be observable: write to a sibling temp file and rename into place.
export async function writeFileAtomic(file: string, data: string, mode = 0o644) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(6).toString("hex")}.tmp`)
  await fs.writeFile(tmp, data, { mode })
  try {
    await fs.rename(tmp, file)
  } catch (err) {
    await fs.rm(tmp, { force: true })
    throw err
  }
}

// Missing files are a normal empty state; anything else (EACCES, EIO, parse
// failures upstream) must surface instead of being read as "empty", because
// an "empty" read cascades into removing every other install's artifacts.
export async function readFileIfExists(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8")
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return undefined
    throw err
  }
}
