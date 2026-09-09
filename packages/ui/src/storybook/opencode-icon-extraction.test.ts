import { expect, test } from "bun:test"
import { extractOpenCodeIcons, extractOpenCodeV2Icons } from "./opencode-icon-extraction"

test.each([
  ["opencode", extractOpenCodeIcons],
  ["opencode-v2", extractOpenCodeV2Icons],
] as const)("the checked-in %s inventory contains the complete current artwork", async (name, extract) => {
  const assets = await extract()
  const directory = new URL(`../assets/icons/${name}/`, import.meta.url)
  expect(await Bun.file(new URL("sprite.svg", directory)).text()).toBe(assets.sprite)
  expect(await Bun.file(new URL("manifest.json", directory)).json()).toEqual(assets.manifest)
})

test("extraction preserves native coordinates and the shared bare terminal prompt", async () => {
  const { manifest, sprite } = await extractOpenCodeIcons()
  const icon = (name: string) => manifest.icons.find((entry) => entry.name === name)!
  expect(icon("magnifying-glass").viewBox).toBe("0 0 16 16")
  expect(icon("folder").viewBox).toBe("0 0 20 20")
  expect(icon("terminal").hash).toBe(icon("terminal-active").hash)
  expect(new Set(manifest.icons.map((entry) => entry.id)).size).toBe(manifest.count)
  expect(sprite.startsWith('<svg xmlns="http://www.w3.org/2000/svg" fill="none">')).toBe(true)
})
