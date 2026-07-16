import { describe, expect, test } from "vitest"
import fs from "node:fs"
import path from "node:path"

type Source = { relativePath: string; source: string }

const joined = (...parts: string[]) => parts.join("")
const rules = [
  [joined("claxedo", "_page"), new RegExp(`${joined("claxedo", "_page")}(?!_status)`)],
  [joined("page", "_context"), new RegExp(joined("page", "_context"))],
  [joined("markdown", "FromContent"), new RegExp(joined("markdown", "FromContent"))],
  [joined("pages", "Api"), new RegExp(joined("pages", "Api"))],
  [joined("pages", "-api"), new RegExp(joined("pages", "-api"))],
  [joined("markdown", "ToDoc"), new RegExp(joined("markdown", "ToDoc"))],
  [joined("Page", "Editor"), new RegExp(joined("Page", "Editor"))],
  [joined("parse", "PageContent"), new RegExp(joined("parse", "PageContent"))],
  [["document", "revision", "id"].join("_"), new RegExp(["document", "revision", "id"].join("_"))],
  ["/pages route", /["'`]\/pages(?:[/?"'`]|$)/],
  [joined("page", "-arena"), new RegExp(joined("page", "-arena"))],
  [joined("pages", "-arena"), new RegExp(joined("pages", "-arena"))],
  [joined("canUse", "Pages"), new RegExp(joined("canUse", "Pages"))],
  [joined("arena", "State"), new RegExp(joined("arena", "State"))],
  [joined("type ", "Arena"), new RegExp(joined("type ", "Arena"))],
  [joined("Pages tour action"), new RegExp(joined("case ", "[\"']", "pages", "[\"']"))],
  [joined("from-repo", " import path"), new RegExp(joined("from-repo", " import path"))],
  [["claxedo", "document", "revision"].join("_"), new RegExp(["claxedo", "document", "revision"].join("_"))],
] as const

export function retiredDocumentSurfaceFindings(sources: Source[]) {
  return sources.flatMap((file) =>
    rules.flatMap(([label, pattern]) =>
      pattern.test(file.relativePath) || pattern.test(file.source) ? [`${file.relativePath}: ${label}`] : [],
    ),
  )
}

describe("Documents replacement staleness guard", () => {
  test("keeps active package source free of retired Pages contracts", () => {
    const repository = path.resolve(import.meta.dirname, "../../../..")
    const sources = fs
      .readdirSync(path.join(repository, "packages"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const source = path.join(repository, "packages", entry.name, "src")
        return fs.existsSync(source) ? sourceFiles(source) : []
      })
      .concat(sourceFiles(path.join(repository, "packages/claxedo-app/public/demo")))
      .filter((file) => !file.includes(`${path.sep}storage${path.sep}claxedo-migration${path.sep}`))
      .filter((file) => file !== import.meta.filename)
      .map((file) => ({ relativePath: path.relative(repository, file), source: fs.readFileSync(file, "utf8") }))

    expect(retiredDocumentSurfaceFindings(sources)).toEqual([])
  })

  test("detects a retired surface from its filename even when its source is empty", () => {
    expect(
      retiredDocumentSurfaceFindings([{ relativePath: joined("src/page", "-arena-helper.ts"), source: "export {}" }]),
    ).toEqual([`${joined("src/page", "-arena-helper.ts")}: ${joined("page", "-arena")}`])
  })
})

function sourceFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") return []
      return sourceFiles(target)
    }
    return /\.(?:ts|tsx|js|jsx|sql|json)$/.test(entry.name) ? [target] : []
  })
}
