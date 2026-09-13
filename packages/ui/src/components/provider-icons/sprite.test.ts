import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { iconNames } from "./types"

/**
 * `sprite.svg` and `types.ts` are both written by the `iconsSpritesheet` plugin
 * in `packages/ui/vite.config.ts` from `src/assets/icons/provider/*.svg`.
 * `ProviderIcon` silently falls back to the `synthetic` sparkle for any id
 * missing from `iconNames`, so a source SVG added without rerunning the
 * generator, or a symbol hand-edited into one file only, shows a wrong mark
 * rather than failing.
 */
const dir = new URL(".", import.meta.url).pathname

const spriteIds = (() => {
  const sprite = readFileSync(`${dir}/sprite.svg`, "utf8")
  return [...sprite.matchAll(/<symbol\b[^>]*\bid="([^"]+)"/g)].flatMap((match) => match[1] ?? [])
})()

const sourceIds = readdirSync(`${dir}/../../assets/icons/provider`)
  .filter((file) => file.endsWith(".svg"))
  .map((file) => file.slice(0, -".svg".length))

describe("provider icon sprite", () => {
  test("carries a symbol for every declared icon name", () => {
    expect([...iconNames].filter((name) => !spriteIds.includes(name))).toEqual([])
  })

  test("declares an icon name for every symbol", () => {
    expect(spriteIds.filter((id) => !iconNames.some((name) => name === id))).toEqual([])
  })

  test("covers every source SVG", () => {
    expect(sourceIds.filter((id) => !iconNames.some((name) => name === id)).sort()).toEqual([])
  })

  test("renders Cursor's own mark, not the fallback", () => {
    expect(iconNames).toContain("cursor")
    const sprite = readFileSync(`${dir}/sprite.svg`, "utf8")
    const symbol = sprite.split('id="cursor"')[1]?.split("</symbol>")[0] ?? ""
    expect(symbol).toContain('fill="currentColor"')
  })
})
