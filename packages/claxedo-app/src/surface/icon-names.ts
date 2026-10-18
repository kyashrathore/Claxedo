import { SURFACE_ICON_NAMES } from "@claxedo/plugin-api/surface"
import type { IconProps } from "@/ui"

export type SurfaceIconName = (typeof SURFACE_ICON_NAMES)[number]

export const KIT_ICONS = {
  add: "plus",
  arrowBack: "arrow-left",
  arrowForward: "arrow-right",
  check: "check",
  close: "close",
  delete: "trash",
  download: "download",
  edit: "edit",
  error: "circle-x",
  fastForward: "chevron-double-right",
  folder: "folder",
  help: "help",
  menu: "menu",
  moreHoriz: "three-dots",
  photo: "photo",
  refresh: "reset",
  rewind: "chevron-double-left",
  search: "magnifying-glass",
  send: "arrow-up",
  settings: "settings-gear",
  share: "share",
  stop: "stop",
  upload: "cloud-upload",
  visibility: "eye",
  warning: "warning",
} as const satisfies Partial<Record<SurfaceIconName, IconProps["name"]>>

export type KitIconName = keyof typeof KIT_ICONS

export type GlyphIconName = Exclude<SurfaceIconName, KitIconName>

export function surfaceIconName(name: unknown): SurfaceIconName | undefined {
  return SURFACE_ICON_NAMES.find((known) => known === name)
}

export function isKitIcon(name: SurfaceIconName): name is KitIconName {
  return Object.hasOwn(KIT_ICONS, name)
}

export type SurfaceIconSource = { readonly kind: "kit"; readonly name: IconProps["name"] } | { readonly kind: "glyph"; readonly name: GlyphIconName }

export function surfaceIconSource(name: SurfaceIconName): SurfaceIconSource {
  return isKitIcon(name) ? { kind: "kit", name: KIT_ICONS[name] } : { kind: "glyph", name }
}
