import { Show } from "solid-js"
import type { PluginIcon } from "../api"

/**
 * The brands the Directory can draw from memory.
 *
 * The catalog carries no colour, so a recognisable product would otherwise be a
 * grey monogram beside every other grey monogram. This table is deliberately
 * small and hand-checked: it names the products the Claxedo collection actually
 * ships, and every other plugin falls through to the hashed hue below rather
 * than to an invented brand.
 *
 * `hue` is the product's own mark colour. It is rendered as a soft tint behind
 * the same colour's monogram, never as a saturated fill, so the tile keeps the
 * app's quiet weight in both colour schemes and needs no glow to read.
 */
const BRANDS: Record<string, { hue: string; mark: string }> = {
  amplitude: { hue: "#1e61f0", mark: "Am" },
  apify: { hue: "#ff9013", mark: "Ap" },
  asana: { hue: "#f06a6a", mark: "As" },
  aws: { hue: "#ff9900", mark: "AW" },
  composio: { hue: "#6c47ff", mark: "Co" },
  context7: { hue: "#2f6fed", mark: "C7" },
  discord: { hue: "#5865f2", mark: "Dc" },
  figma: { hue: "#f24e1e", mark: "Fg" },
  firebase: { hue: "#ffca28", mark: "Fb" },
  github: { hue: "#8b949e", mark: "GH" },
  gitlab: { hue: "#fc6d26", mark: "GL" },
  gmail: { hue: "#ea4335", mark: "Gm" },
  "google-calendar": { hue: "#4285f4", mark: "GC" },
  "google-drive": { hue: "#34a853", mark: "GD" },
  granola: { hue: "#e4572e", mark: "Gr" },
  jira: { hue: "#2684ff", mark: "Jr" },
  linear: { hue: "#5e6ad2", mark: "Ln" },
  notion: { hue: "#9b9a97", mark: "No" },
  posthog: { hue: "#f54e00", mark: "Ph" },
  slack: { hue: "#36c5f0", mark: "Sl" },
  stripe: { hue: "#635bff", mark: "St" },
  vercel: { hue: "#a1a1aa", mark: "Vc" },
}

/** The brand key a plugin name resolves to, or `undefined` for an unknown product. */
export function brandKey(name: string) {
  const normalized = name.trim().toLowerCase().replace(/\s+/g, "-")
  if (BRANDS[normalized]) return normalized
  // `composio-mcp`, `github-issues`: a suffixed variant is still that product.
  return Object.keys(BRANDS).find((key) => normalized.startsWith(`${key}-`))
}

/**
 * A stable hue for a name the table does not know.
 *
 * Deterministic so the same plugin keeps the same tile across reloads and
 * across machines; saturation and lightness are fixed so an unknown plugin can
 * never out-shout a real brand.
 */
function hashedHue(name: string) {
  let hash = 0
  for (let index = 0; index < name.length; index++) hash = (hash * 31 + name.charCodeAt(index)) % 360
  return `hsl(${hash} 42% 52%)`
}

/**
 * A plugin's tile: the icon its manifest declares, else the product's brand
 * mark, else a hashed monogram. `icon.kind === "url"` always wins, because a
 * manifest that ships artwork has said what it wants to look like.
 */
export function PluginIconTile(props: { icon?: PluginIcon; name: string; size?: "card" | "pane" }) {
  const size = () => (props.size === "pane" ? "size-12 text-14-medium" : "size-10 text-12-medium")
  const url = () => {
    const icon = props.icon
    return icon && icon.kind === "url" ? icon.url : undefined
  }
  const brand = () => {
    const key = brandKey(props.name)
    return key ? BRANDS[key] : undefined
  }
  const hue = () => brand()?.hue ?? hashedHue(props.name)
  const mark = () => {
    const known = brand()
    if (known) return known.mark
    const icon = props.icon
    return icon && icon.kind === "monogram" ? icon.text : props.name.slice(0, 2).toUpperCase()
  }
  return (
    <span
      aria-hidden="true"
      data-component="agent-plugin-icon"
      data-brand={brandKey(props.name)}
      style={{
        "--agent-plugin-hue": hue(),
        "--agent-plugin-tile": `color-mix(in srgb, ${hue()} 16%, transparent)`,
      }}
      class={`shrink-0 grid place-items-center overflow-hidden rounded-lg bg-[var(--agent-plugin-tile)] text-[var(--agent-plugin-hue)] ${size()}`}
    >
      <Show when={url()} fallback={mark()}>
        {(src) => <img src={src()} alt="" class="size-full object-cover" />}
      </Show>
    </span>
  )
}
