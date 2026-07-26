import { appIconNames, type AppIconName } from "@/ui/icons/catalog"
import { CODEX_ICON_ALIASES, type CodexGlyphName } from "@/ui/icons/codex"

export type IconManifestEntry = {
  glyph: CodexGlyphName
  description: string
  active?: AppIconName
}

const activeIcons = {
  folder: "folder-open",
  pin: "pin-filled",
  review: "review-active",
  sidebar: "sidebar-active",
  status: "status-active",
  terminal: "terminal-active",
} as const satisfies Partial<Record<AppIconName, AppIconName>>

export const codexIconManifest = Object.fromEntries(
  appIconNames.map((name) => [
    name,
    {
      glyph: CODEX_ICON_ALIASES[name],
      description: name
        .replace(/^outline-/, "")
        .replaceAll("-", " ")
        .replace(/^\w/, (letter) => letter.toUpperCase()),
      ...(activeIcons[name as keyof typeof activeIcons] ? { active: activeIcons[name as keyof typeof activeIcons] } : {}),
    },
  ]),
) as Record<AppIconName, IconManifestEntry>
