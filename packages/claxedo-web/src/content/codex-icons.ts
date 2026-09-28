import aliasSource from "../../../claxedo-app/src/ui/icons/codex.ts?raw"
import iconSource from "../../../claxedo-app/src/ui/controls/claxedo-icon.tsx?raw"
import sprite from "../../../ui/src/assets/icons/codex/sprite.svg?raw"
import { CODEX_CUSTOM_ARTWORK } from "../../../ui/src/components/codex-custom-artwork"
import { HARNESS_BRAND_ARTWORK } from "../../../ui/src/components/harness-brand-artwork"

/**
 * The app's Codex icon library, resolved at build time from its own sources:
 * `codex.ts` maps a semantic name to a glyph, `claxedo-icon.tsx` draws the
 * `codex-custom-*` glyphs, and the kit's sprite holds the rest. Reading the
 * sources keeps one table; a name the app renames or drops fails the build.
 */
const sourceBlock = (source: string, start: string, end: string) => source.split(start)[1]?.split(end)[0] ?? ""
const entries = (text: string, value: RegExp) =>
  Object.fromEntries([...text.matchAll(value)].map((match) => [match[1], match[2]]))

const aliases = entries(sourceBlock(aliasSource, "CODEX_ICON_ALIASES = {", "} as const"), /^\s*"?([a-zA-Z0-9-]+)"?:\s*"([a-z0-9-]+)"/gm)
const transforms = entries(sourceBlock(aliasSource, "CODEX_ICON_TRANSFORMS = {", "} as const"), /^\s*"?([a-zA-Z0-9-]+)"?:\s*"([^"]+)"/gm)
const customGlyphs = entries(sourceBlock(iconSource, "const customGlyphs = {", "} as const"), /"(codex-custom-[a-z0-9-]+)"\s*:\s*"([a-zA-Z0-9-]+)"/g)
const localArtwork: Record<string, string> = {
  ...CODEX_CUSTOM_ARTWORK,
  ...HARNESS_BRAND_ARTWORK,
  ...entries(sourceBlock(iconSource, "const claxedoIcons = {", "\n}\n"), /^\s*"?([a-z0-9-]+)"?:\s*`([^`]*)`/gm),
}
const spriteSymbols = Object.fromEntries(
  [...sprite.matchAll(/<symbol id="([^"]+)"([^>]*)>([\s\S]*?)<\/symbol>/g)].map((match) => [match[1], { attributes: match[2], body: match[3] }]),
)

export const DEMO_ICONS = [
  "layout-left-partial",
  "layout-right-partial",
  "layout-right-full",
  "close-small",
  "plus",
  "plus-small",
  "terminal",
  "chevron-down",
  "chevron-right",
  "chevron-double-left",
  "chevron-double-right",
  "review",
  "changes",
  "file",
  "document-text",
  "expand",
  "collapse",
  "expand-all",
  "split",
  "open-external",
  "folder",
  "folder-add",
  "marketplace",
  "checklist",
  "monitor",
  "warning",
  "gauge",
  "settings-gear",
  "help",
  "three-dots",
  "branch",
  "github",
  "scroll-to-latest",
  "shield",
  "magnifying-glass",
  "send",
  "check",
] as const

export type DemoIconName = (typeof DEMO_ICONS)[number]

export const codexIconId = (name: DemoIconName) => `codex-icon-${name}`

export const demoIconTransform = (name: DemoIconName): string | undefined => transforms[name]

/** The `<symbol>` that draws `name`, as the app's ClaxedoIcon would draw it in the Codex theme. */
export function codexSymbol(name: DemoIconName): string {
  const glyph = aliases[name]
  if (!glyph) throw new Error(`The app's Codex icon table has no "${name}"`)
  if (glyph.startsWith("codex-custom-")) {
    const artwork = localArtwork[customGlyphs[glyph] ?? ""]
    if (!artwork) throw new Error(`No artwork draws ${glyph} for "${name}"`)
    return `<symbol id="${codexIconId(name)}" viewBox="0 0 20 20" fill="none">${artwork}</symbol>`
  }
  const symbol = spriteSymbols[glyph]
  if (!symbol) throw new Error(`The Codex sprite has no ${glyph} for "${name}"`)
  return `<symbol id="${codexIconId(name)}"${symbol.attributes}>${symbol.body}</symbol>`
}
