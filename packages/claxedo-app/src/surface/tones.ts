import { SURFACE_BADGE_TONES, type SurfaceComponent } from "@claxedo/plugin-api/surface"
import type { IconProps, TagProps } from "@/ui"

type Definition<Name extends SurfaceComponent["component"]> = Extract<SurfaceComponent, { component: Name }>

export type BadgeTone = (typeof SURFACE_BADGE_TONES)[number]

export function badgeTone(value: unknown): BadgeTone {
  return SURFACE_BADGE_TONES.find((tone) => tone === value) ?? "neutral"
}
export type StatTone = NonNullable<Definition<"Stat">["tone"]>
export type CalloutTone = Definition<"Callout">["tone"]

export function badgeTagVariant(tone: BadgeTone): NonNullable<TagProps["variant"]> {
  return tone === "accent" ? "accent" : "neutral"
}

export const CALLOUT_ICONS: Readonly<Record<CalloutTone, IconProps["name"]>> = {
  info: "circle-alert",
  success: "circle-check",
  warning: "warning",
  danger: "circle-x",
}
