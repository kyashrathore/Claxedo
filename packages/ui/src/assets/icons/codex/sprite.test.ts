import { describe, expect, test } from "bun:test"
import manifest from "./manifest.json"

describe("Codex icon sprite", () => {
  test("preserves every source SVG's root paint attributes", async () => {
    const sprite = await Bun.file(`${import.meta.dir}/sprite.svg`).text()

    await Promise.all(
      manifest.icons.map(async (icon) => {
        const source = await Bun.file(`${import.meta.dir}/${icon.file}`).text()
        const sourceAttributes = attributes(source.match(/^<svg\b([^>]*)>/)?.[1]) ?? {}
        const symbolAttributes = attributes(
            sprite.match(new RegExp(`<symbol id="${icon.id}"([^>]*)>`))?.[1],
        )

        expect(symbolAttributes).toBeDefined()
        Object.entries(sourceAttributes)
          .filter(([name]) => name !== "xmlns" && name !== "width" && name !== "height")
          .forEach(([name, value]) => expect(symbolAttributes?.[name]).toBe(value))
      }),
    )
  })
})

function attributes(input?: string) {
  if (!input) return undefined
  return Object.fromEntries([...input.matchAll(/([\w:-]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]))
}
