import { describe, expect, test } from "vitest"
import fs from "node:fs"
import path from "node:path"

describe("legacy document revision retirement", () => {
  test("keeps active source free of the retired revision columns and tables", () => {
    const repository = path.resolve(import.meta.dirname, "../../../..")
    const roots = ["packages/claxedo-server/src", "packages/claxedo-app/src", "packages/workgraph/src"]
    const terms = [["document", "revision", "id"].join("_"), ["claxedo", "document", "revision"].join("_")]
    const offenders = roots
      .flatMap((root) => files(path.join(repository, root)))
      // Applied migrations are history: they legitimately name the retired
      // table/column because that is what they created at the time, and their
      // text is hashed by the migration runner. Keyed on the migration
      // directory alone — the parent (`storage/`, now `db/`) is incidental, and
      // pinning it here silently un-excluded these files when the dir moved.
      .filter((file) => !file.includes(`${path.sep}claxedo-migration${path.sep}`))
      .filter((file) => file !== import.meta.filename)
      .flatMap((file) => {
        const source = fs.readFileSync(file, "utf8")
        return terms
          .filter((term) => source.includes(term))
          .map((term) => `${path.relative(repository, file)}: ${term}`)
      })

    expect(offenders).toEqual([])
  })
})

function files(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name)
    if (entry.isDirectory()) return files(target)
    return /\.(?:ts|tsx|sql)$/.test(entry.name) ? [target] : []
  })
}
