import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { walk, type SourceFile } from "./scanners"

const appRoot = path.resolve(import.meta.dir, "../..")
const uiRoot = path.resolve(appRoot, "../ui")
const migratedTokens = [
  "--codex-elevation-card",
  "--codex-elevation-stroke",
  "--codex-radius-overlay",
  "--codex-shadow-hairline",
  "--codex-shadow-overlay",
  "--codex-shadow-raised",
  "--codex-shadow-sidebar-edge",
] as const

describe("Codex theme architecture", () => {
  test("recognizes a reintroduced migrated-token definition", () => {
    expect(migratedTokenDefinitions([
      { path: "bad.css", text: ":root { --codex-shadow-overlay: 0 0 #0000; }" },
    ])).toEqual(["bad.css: --codex-shadow-overlay"])
  })

  test("keeps migrated semantic tokens out of every stylesheet", () => {
    const files = [path.join(appRoot, "src"), path.join(uiRoot, "src")]
      .flatMap(walk)
      .filter((file) => file.endsWith(".css"))
      .map((file) => ({ path: path.relative(path.resolve(appRoot, "../.."), file), text: readFileSync(file, "utf8") }))

    expect(migratedTokenDefinitions(files)).toEqual([])
  })
})

function migratedTokenDefinitions(files: SourceFile[]) {
  return files.flatMap((file) => migratedTokens
    .filter((token) => new RegExp(`${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`).test(file.text))
    .map((token) => `${file.path}: ${token}`))
}
