import { getOpenCodeIconArtwork, openCodeIconNames } from "../components/icon"
import { getOpenCodeV2IconArtwork, openCodeV2IconNames } from "../v2/components/icon"

/** Build the source snapshots linked by the Storybook reference. */
export function extractOpenCodeIcons() {
  return extractArtwork(openCodeIconNames.map(getOpenCodeIconArtwork), "packages/ui/src/components/icon.tsx")
}

export function extractOpenCodeV2Icons() {
  return extractArtwork(openCodeV2IconNames.map(getOpenCodeV2IconArtwork), "packages/ui/src/components/opencode-v2-artwork.tsx")
}

async function extractArtwork(
  artwork: { id: string; name: string; viewBox: string; content: string }[],
  source: string,
) {
  const hashes = await Promise.all(
    artwork.map(async (icon) => {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${icon.viewBox}\n${icon.content}`))
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
    }),
  )
  const seen = new Map<string, string>()
  const icons = artwork.map(({ content: _content, ...icon }, index) => {
    const hash = hashes[index]
    const duplicateOf = seen.get(hash)
    if (!duplicateOf) seen.set(hash, icon.id)
    return { ...icon, hash, ...(duplicateOf ? { duplicateOf } : {}) }
  })
  return {
    sprite: `<svg xmlns="http://www.w3.org/2000/svg" fill="none">\n${artwork
      .map((icon) => `<symbol id="${icon.id}" viewBox="${icon.viewBox}">${icon.content}</symbol>`)
      .join("\n")}\n</svg>\n`,
    manifest: {
      source,
      extraction: "Source artwork; SHA-256 of viewBox + newline + SVG content",
      count: icons.length,
      uniqueGeometries: seen.size,
      icons,
    },
  }
}
