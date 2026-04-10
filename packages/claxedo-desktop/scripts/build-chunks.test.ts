import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import test from "node:test"

const dir = path.resolve(import.meta.dir, "../out/renderer/assets")

function chunks(): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((file) => file.endsWith(".js"))
}

function hash(file: string): string {
  return createHash("sha256")
    .update(fs.readFileSync(path.join(dir, file)))
    .digest("hex")
}

test("no duplicate chunk", () => {
  const files = chunks()
  assert.ok(files.length > 0, `no JS chunks found in ${dir} — run build first`)

  const seen = new Map<string, string[]>()
  for (const file of files) {
    const key = hash(file)
    const list = seen.get(key) ?? []
    list.push(file)
    seen.set(key, list)
  }

  const dups = [...seen.values()]
    .filter((list) => list.length > 1)
    .sort((a, b) => a[0].localeCompare(b[0]))

  assert.equal(
    dups.length,
    0,
    `duplicate JS chunks found:\n${dups.map((list) => `  ${list.join(", ")}`).join("\n")}`,
  )
})
