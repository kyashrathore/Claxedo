import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { ICONS } from "../src/icons"

const root = new URL("..", import.meta.url).pathname
const dist = join(root, "dist")

/** The glyphs copied out of the ChatGPT desktop app, which claxedo.com must never ship. */
const copiedPaths = new Set(
  [...readFileSync(new URL("../../ui/src/assets/icons/codex/sprite.svg", import.meta.url), "utf8").matchAll(/\sd="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((d) => d.length > 30),
)
const copiedIds = /codex-(?:20|native)-/

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })

describe("site icons are the site's own", () => {
  test("no icon reuses a copied Codex glyph path", () => {
    const reused = Object.entries(ICONS).filter(([, markup]) =>
      [...markup.matchAll(/\sd="([^"]+)"/g)].some((match) => copiedPaths.has(match[1])),
    )
    expect(reused.map(([name]) => name)).toEqual([])
  })

  test("no source file reaches for the copied sprite", () => {
    const offenders = files(join(root, "src"))
      .filter((path) => !path.endsWith("LICENSE.md"))
      .filter((path) => {
        const text = readFileSync(path, "utf8")
        return copiedIds.test(text) || text.includes("assets/icons/codex")
      })
    expect(offenders).toEqual([])
  })

  test.skipIf(!existsSync(dist))("the built site ships no copied glyph", () => {
    const offenders = files(dist)
      .filter((path) => /\.(html|js|css|svg|md)$/.test(path))
      .filter((path) => {
        const text = readFileSync(path, "utf8")
        return copiedIds.test(text) || [...copiedPaths].some((d) => text.includes(d))
      })
    expect(offenders).toEqual([])
  })
})
