import { extractOpenCodeIcons, extractOpenCodeV2Icons } from "../src/storybook/opencode-icon-extraction"

for (const [name, extract] of [
  ["opencode", extractOpenCodeIcons],
  ["opencode-v2", extractOpenCodeV2Icons],
] as const) {
  const assets = await extract()
  const directory = new URL(`../src/assets/icons/${name}/`, import.meta.url)
  await Bun.write(new URL("sprite.svg", directory), assets.sprite)
  await Bun.write(new URL("manifest.json", directory), JSON.stringify(assets.manifest, null, 2) + "\n")
  console.log(
    `Extracted ${assets.manifest.count} ${name} icons (${assets.manifest.uniqueGeometries} unique geometries).`,
  )
}
