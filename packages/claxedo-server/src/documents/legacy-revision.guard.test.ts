import { describe, expect, test } from "vitest"
import fs from "node:fs"
import path from "node:path"

describe("legacy document revision retirement", () => {
  test("keeps active source free of the retired revision columns and tables", () => {
    const repository = path.resolve(import.meta.dirname, "../../../..")
    const roots = ["packages/claxedo-server/src", "packages/claxedo-app/src", "packages/workgraph/src", "convex"]
    const terms = [["document", "revision", "id"].join("_"), ["claxedo", "document", "revision"].join("_")]
    const offenders = roots
      .flatMap((root) => files(path.join(repository, root)))
      .filter((file) => !file.includes(`${path.sep}storage${path.sep}claxedo-migration${path.sep}`))
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
