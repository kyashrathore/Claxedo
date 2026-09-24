import { Show, type JSX } from "solid-js"
import type { PluginIcon } from "@/server"
import { ClaxedoLogo } from "@/ui"

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

export function brandKey(name: string) {
  const normalized = name.trim().toLowerCase().replace(/\s+/g, "-")
  if (BRANDS[normalized]) return normalized
  return Object.keys(BRANDS).find((key) => normalized.startsWith(`${key}-`))
}

function hashedHue(name: string) {
  let hash = 0
  for (let index = 0; index < name.length; index++) hash = (hash * 31 + name.charCodeAt(index)) % 360
  return `hsl(${hash} 42% 52%)`
}

export function PluginIconTile(props: {
  readonly icon?: PluginIcon
  readonly name: string
  readonly size?: "card" | "pane"
  readonly builtIn?: boolean
}): JSX.Element {
  const size = () => (props.size === "pane" ? "size-12 text-14-medium" : "size-10 text-12-medium")
  const url = () => {
    const icon = props.icon
    return icon && icon.kind === "url" ? icon.url : undefined
  }
  const brand = () => {
    const key = brandKey(props.name)
    return key ? BRANDS[key] : undefined
  }
  const hue = () => (props.builtIn ? "var(--icon-strong-base)" : (brand()?.hue ?? hashedHue(props.name)))
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
      data-brand={props.builtIn ? "claxedo" : brandKey(props.name)}
      style={{
        "--agent-plugin-hue": hue(),
        "--agent-plugin-tile": `color-mix(in srgb, ${hue()} ${props.builtIn ? 8 : 16}%, transparent)`,
      }}
      class={`shrink-0 grid place-items-center overflow-hidden rounded-lg bg-[var(--agent-plugin-tile)] text-[var(--agent-plugin-hue)] ${size()}`}
    >
      <Show
        when={props.builtIn}
        fallback={
          <Show when={url()} fallback={mark()}>
            {(src) => <img src={src()} alt="" class="size-full object-cover" />}
          </Show>
        }
      >
        <ClaxedoLogo class={props.size === "pane" ? "size-7" : "size-6"} />
      </Show>
    </span>
  )
}
