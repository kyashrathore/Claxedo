import { resolveIconArtworkLibrary } from "@opencode-ai/ui/icon-artwork-policy"
import { CODEX_CUSTOM_ARTWORK } from "@opencode-ai/ui/codex-custom-artwork"
import { HARNESS_BRAND_ARTWORK } from "@opencode-ai/ui/harness-brand-artwork"
import { createEffect, Show, splitProps, type ComponentProps } from "solid-js"
// ⚠️ Licence risk — see the note in
// `packages/ui/src/components/codex-icons.tsx`. The Codex branch of this
// component renders artwork extracted from the proprietary ChatGPT desktop app.
// The explicit artwork policy selects approved shared marks across themes.
import {
  ensureSvgSpriteHost,
  OpenCodeIcon as UpstreamIcon,
} from "@opencode-ai/ui/icon"
import { codexIconSprite } from "@opencode-ai/ui/codex-icons"
import { iconLibrary } from "@/ui/icons/config"
import type { AppIconName } from "@/ui/icons/catalog"
import {
  CODEX_ICON_TRANSFORMS,
  codexIconLibrary,
  type CodexCustomGlyph,
  type CodexGlyphName,
} from "@/ui/icons/codex"
import { openCodeIconLibrary } from "@/ui/icons/opencode"

const claxedoIcons = {
  ...CODEX_CUSTOM_ARTWORK,
  ...HARNESS_BRAND_ARTWORK,
  check: `<path d="M5 11.9657L8.37838 14.7529L15 5.83398" stroke="currentColor" stroke-linecap="square"/>`,
  // Dismiss marks. The extracted Codex sprite has no bare X — its only X sits
  // inside a ring (codex-20-121), which `circle-x` uses as a *status* glyph — so
  // both sizes are drawn here. `close` is byte-identical to the `close` entry in
  // the upstream `icons` table in `packages/ui/src/components/icon.tsx`, so a
  // callsite renders the same mark whichever component it reaches for.
  close: `<path d="M3.75 3.75L16.25 16.25M16.25 3.75L3.75 16.25" stroke="currentColor" stroke-linecap="square"/>`,
  "close-small": `<path d="M6.75 6.75L13.25 13.25M13.25 6.75L6.75 13.25" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>`,
  copy: `<rect x="7" y="6.5" width="8.5" height="8.5" rx="2" stroke="currentColor" stroke-width="1.25"/><path d="M12.5 4.5H6.5C5.39543 4.5 4.5 5.39543 4.5 6.5V12.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>`,
  file: `<path d="M12.5 1.66667H5C4.07953 1.66667 3.33333 2.41286 3.33333 3.33333V16.6667C3.33333 17.5871 4.07953 18.3333 5 18.3333H15C15.9205 18.3333 16.6667 17.5871 16.6667 16.6667V5.83333L12.5 1.66667Z" stroke="currentColor" stroke-linecap="square"/><path d="M11.6667 1.66667V4.16667C11.6667 5.08714 12.4129 5.83333 13.3333 5.83333H16.6667" stroke="currentColor" stroke-linecap="square"/>`,
  "page-plus": `<path d="M9.5 2.5H4.5C3.94772 2.5 3.5 2.94772 3.5 3.5V16.5C3.5 17.0523 3.94772 17.5 4.5 17.5H10M9.5 2.5L12.5 5.5M9.5 2.5V4.5C9.5 5.05228 9.94772 5.5 10.5 5.5H12.5V9.5M14.5 11.5V17.5M11.5 14.5H17.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>`,
  send: `<path d="M10 15.5V4.5M5.75 8.75L10 4.5L14.25 8.75" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>`,
  stop: `<rect x="6" y="6" width="8" height="8" rx="1" fill="currentColor"/>`,
  // Trunk splitting into two bracketed arrows. Drawn to a ~10-unit optical box
  // (matching `folder-open` / `gauge`) rather than the full 20-unit grid — at the
  // original 13-unit height it read a size larger than its toolbar neighbours.
  // Stroke sits at 1.25: the set default of 1 leaves the small arrowheads too
  // faint, but the previous 1.5 was heavier than everything beside it.
  worktree: `<path d="M5 10H8.5L13.5 5M11 5H13.5V7.5M8.5 10L13.5 15M11 15H13.5V12.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="square" stroke-linejoin="miter"/>`,
  // Navigation marks. The extracted sprite has no distinct glyph for any of
  // these three, so all three would alias codex-20-123 — one sparkle standing
  // in for Marketplace, Models and Providers at once. Drawn locally instead: a
  // three-tile plugin cluster, a sparkle, and a chip. The marketplace mark's
  // fourth tile is a plus: "add to your set". Geometry matches the same three
  // names in the upstream `icons` table in `packages/ui/src/components/icon.tsx`,
  // so a callsite renders the same mark whichever component it reaches for.
  marketplace: `<rect x="2.5" y="2.5" width="6.25" height="6.25" rx="1.25" stroke="currentColor" stroke-width="1.25"/><rect x="11.25" y="2.5" width="6.25" height="6.25" rx="1.25" stroke="currentColor" stroke-width="1.25"/><rect x="2.5" y="11.25" width="6.25" height="6.25" rx="1.25" stroke="currentColor" stroke-width="1.25"/><path d="M14.375 11.25V17.5M11.25 14.375H17.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>`,
  models: `<path fill-rule="evenodd" clip-rule="evenodd" d="M17.5 10C12.2917 10 10 12.2917 10 17.5C10 12.2917 7.70833 10 2.5 10C7.70833 10 10 7.70833 10 2.5C10 7.70833 12.2917 10 17.5 10Z" stroke="currentColor"/>`,
  providers: `<path d="M10.0001 4.37562V2.875M13 4.37793V2.87793M7.00014 4.37793V2.875M10 17.1279V15.6279M13 17.1279V15.6279M7 17.1279V15.6279M15.625 13.0029H17.125M15.625 7.00293H17.125M15.625 10.0029H17.125M2.875 10.0029H4.375M2.875 13.0029H4.375M2.875 7.00293H4.375M4.375 4.37793H15.625V15.6279H4.375V4.37793ZM12.6241 10.0022C12.6241 11.4519 11.4488 12.6272 9.99908 12.6272C8.54934 12.6272 7.37408 11.4519 7.37408 10.0022C7.37408 8.55245 8.54934 7.3772 9.99908 7.3772C11.4488 7.3772 12.6241 8.55245 12.6241 10.0022Z" stroke="currentColor" stroke-linecap="square"/>`,
  "three-dots": `<circle cx="5" cy="10" r="1.6" fill="currentColor"/><circle cx="10" cy="10" r="1.6" fill="currentColor"/><circle cx="15" cy="10" r="1.6" fill="currentColor"/>`,
  // Official Model Context Protocol mark, from lobe-icons (MIT) on a 24 grid,
  // scaled onto this component's 20 one. Byte-identical to the `mcp` entry in
  // `packages/ui/src/components/icon.tsx` so both components draw the same mark.
  mcp: `<g transform="scale(0.83333)" fill="currentColor" fill-rule="evenodd" clip-rule="evenodd"><path d="M15.688 2.343a2.588 2.588 0 00-3.61 0l-9.626 9.44a.863.863 0 01-1.203 0 .823.823 0 010-1.18l9.626-9.44a4.313 4.313 0 016.016 0 4.116 4.116 0 011.204 3.54 4.3 4.3 0 013.609 1.18l.05.05a4.115 4.115 0 010 5.9l-8.706 8.537a.274.274 0 000 .393l1.788 1.754a.823.823 0 010 1.18.863.863 0 01-1.203 0l-1.788-1.753a1.92 1.92 0 010-2.754l8.706-8.538a2.47 2.47 0 000-3.54l-.05-.049a2.588 2.588 0 00-3.607-.003l-7.172 7.034-.002.002-.098.097a.863.863 0 01-1.204 0 .823.823 0 010-1.18l7.273-7.133a2.47 2.47 0 00-.003-3.537z"/><path d="M14.485 4.703a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a4.115 4.115 0 000 5.9 4.314 4.314 0 006.016 0l7.12-6.982a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a2.588 2.588 0 01-3.61 0 2.47 2.47 0 010-3.54l7.12-6.982z"/></g>`,
  "magnifying-glass": `<path d="M15.75 15.75L12.8023 12.8023M14.444 8.34701C14.444 11.4382 11.9382 13.944 8.84701 13.944C5.75587 13.944 3.25 11.4382 3.25 8.34701C3.25 5.25587 5.75587 2.75 8.84701 2.75C11.9382 2.75 14.444 5.25587 14.444 8.34701Z" stroke="currentColor" stroke-linecap="square"/>`,
  "magnifying-glass-menu": `<path d="M2.08325 10.0002H4.58325M2.08325 5.41683H5.41659M2.08325 14.5835H5.41659M16.4583 13.9585L18.7499 16.2502M17.9166 10.0002C17.9166 12.9917 15.4915 15.4168 12.4999 15.4168C9.50838 15.4168 7.08325 12.9917 7.08325 10.0002C7.08325 7.00862 9.50838 4.5835 12.4999 4.5835C15.4915 4.5835 17.9166 7.00862 17.9166 10.0002Z" stroke="currentColor" stroke-linecap="square"/>`,
  // Codex authors project disclosure folders on a 16px grid. Scale those
  // source paths into this component's 20px sprite without altering geometry.
  folder: `<g transform="scale(1.25)"><path d="M5.36914 2.1416C5.92368 2.14164 6.3602 2.23705 6.73242 2.38965C7.09745 2.53934 7.38155 2.73818 7.61816 2.9043C8.07599 3.22573 8.42077 3.47464 9.16602 3.47461H11.9473C13.3336 3.47484 14.4453 4.61217 14.4453 6V7.06543C14.4453 7.07196 14.4435 7.07845 14.4434 7.08496V11.3311C14.4432 12.7187 13.3316 13.8562 11.9453 13.8564H4.05371C2.66747 13.8562 1.55583 12.7187 1.55566 11.3311V7.35059C1.55545 7.34451 1.55377 7.33815 1.55371 7.33203C1.55371 7.32563 1.55539 7.31884 1.55566 7.3125V4.66699C1.55566 3.27918 2.66737 2.14185 4.05371 2.1416H5.36914ZM2.60547 7.85645V11.3311C2.60563 12.1519 3.26037 12.8054 4.05371 12.8057H11.9453C12.7387 12.8054 13.3934 12.1519 13.3936 11.3311V7.85645H2.60547ZM4.05371 3.19238C3.26027 3.19264 2.60547 3.84598 2.60547 4.66699V6.80664H13.3955V6C13.3955 5.17898 12.7407 4.52562 11.9473 4.52539H9.16699C8.07975 4.52558 7.50694 4.10863 7.01562 3.76367C6.77766 3.5966 6.57849 3.46159 6.33398 3.36133C6.09656 3.264 5.79646 3.19242 5.36914 3.19238H4.05371Z" fill="currentColor"/></g>`,
  "folder-open": `<g transform="scale(1.25)"><path fill-rule="evenodd" clip-rule="evenodd" d="M4.75488 2.1416C5.30942 2.14164 5.74594 2.23705 6.11816 2.38965C6.48323 2.53934 6.76728 2.73817 7.00391 2.9043L7.02148 2.91699C7.47057 3.23238 7.8162 3.47463 8.55176 3.47461H11.333C12.7194 3.47484 13.8311 4.61217 13.8311 6L13.875 6.38281H13.8594C14.8729 6.38292 15.5982 7.3629 15.3018 8.33203L14.0068 12.5586C13.7703 13.3297 13.0576 13.8563 12.251 13.8564H3.83984C3.4199 13.8564 3.04144 13.7174 2.73828 13.4883L2.67383 13.4346C1.99907 12.9811 1.55577 12.2065 1.55566 11.3311L0.941406 4.66699C0.941406 3.2792 2.05315 2.1419 3.43945 2.1416H4.75488ZM4.7627 7.42969C4.56039 7.42972 4.3807 7.5625 4.32129 7.75586L3.08594 11.7891C2.96123 12.1965 3.18214 12.6072 3.54883 12.7529C3.63476 12.7768 3.74102 12.7958 3.88184 12.8086H12.251C12.5974 12.8085 12.9033 12.5821 13.0049 12.251L14.2998 8.02539C14.3901 7.72947 14.1688 7.42979 13.8594 7.42969H4.7627ZM3.43945 3.19141C2.64724 3.1917 1.99121 3.84481 1.99121 4.66699L2.49316 10.1201L3.32031 7.44922C3.51452 6.81571 4.10008 6.38284 4.7627 6.38281H12.8252L12.7812 6C12.7812 5.22902 12.2045 4.607 11.4795 4.53223L11.333 4.52441H8.55176C8.05756 4.52442 7.64464 4.44062 7.2666 4.2793C6.91453 4.12896 6.6274 3.92345 6.41797 3.77637L6.40039 3.76367C6.16212 3.59639 5.96404 3.46151 5.71973 3.36133C5.54113 3.28812 5.32754 3.2289 5.05176 3.2041L4.75488 3.19141H3.43945Z" fill="currentColor"/></g>`,
  "panel-restore": `<g transform="scale(1.25)"><path d="M6.1664 8.80845C6.7325 8.80845 7.1918 9.26774 7.1918 9.83384V13.3338C7.19155 13.6236 6.9562 13.8592 6.6664 13.8592C6.37672 13.8591 6.14126 13.6235 6.14101 13.3338V10.5936L2.70547 14.0379C2.50071 14.243 2.16753 14.2435 1.9623 14.0389C1.75709 13.8342 1.75665 13.501 1.96133 13.2957L5.39101 9.85923H2.6664C2.37672 9.85909 2.14126 9.6235 2.14101 9.33384C2.14101 9.04397 2.37657 8.80858 2.6664 8.80845H6.1664Z" fill="currentColor"/><path d="M13.2943 1.96274C13.4989 1.75743 13.8311 1.75731 14.0365 1.96177C14.2419 2.16637 14.243 2.49854 14.0385 2.70395L10.6127 6.14145H13.3334C13.6233 6.14145 13.8588 6.37689 13.8588 6.66684C13.8587 6.95674 13.6233 7.19223 13.3334 7.19223H9.8334C9.26734 7.19223 8.80807 6.73288 8.80801 6.16684V2.66684C8.80801 2.37689 9.04345 2.14145 9.3334 2.14145C9.62335 2.14145 9.85879 2.37689 9.85879 2.66684V5.41098L13.2943 1.96274Z" fill="currentColor"/></g>`,
  // Monochrome harness marks: Claude, Cursor, OpenAI and Pi use the MIT-licensed
  // LobeHub geometry; OpenCode uses its official brand/provider geometry.
  // They are authored on a 0 0 24 24 grid. Rather than scale to fill the sprite
  // (20/24 → edge-to-edge), we scale the 24-unit art down to ~14 units and
  // centre it (translate 3). These logos are dense and *filled*, so at full
  // size they read much heavier than the thin line glyphs beside them (+, ›,
  // chevron); the extra padding brings their perceived size into line.
  // Filled with currentColor so they inherit the toolbar's idle/hover color.
  // The official 24px source includes its own four-unit horizontal inset.
  // Scale that source to a 12×15px optical mark inside the 20px slot: smaller
  // than its former full-height rendering, but not the tiny 8px square produced
  // by treating the source's built-in whitespace as visible geometry.
}

export type ClaxedoIconName = AppIconName

export interface ClaxedoIconProps extends Omit<ComponentProps<"svg">, "name"> {
  name: ClaxedoIconName
  /** Explicit theme family for reference previews; shared artwork policy still applies. */
  library?: "codex" | "opencode"
  size?: "small" | "normal" | "medium" | "large"
}

const spriteID = "claxedo-icon-sprite"
const symbol = (name: string) => `claxedo-icon-${name}`
let spriteInserted = false

function ensureSprite() {
  if (spriteInserted) return
  if (typeof document === "undefined") return
  const markup = Object.entries(claxedoIcons)
    .map(([name, path]) => `<symbol id="${symbol(name)}" viewBox="0 0 20 20">${path}</symbol>`)
    .join("")
  const existing = document.getElementById(spriteID)
  if (existing) {
    // The sprite survives Vite HMR in document.body. Refresh its symbols when
    // this module reloads so changed shared glyphs do not retain stale paths.
    existing.innerHTML = markup
    spriteInserted = true
    return
  }
  const svg = ensureSvgSpriteHost(spriteID)
  if (!svg) return
  svg.innerHTML = markup
  spriteInserted = true
}

const customGlyphs = {
  "codex-custom-check": "check",
  "codex-custom-claude": "claude",
  "codex-custom-close": "close",
  "codex-custom-close-small": "close-small",
  "codex-custom-copy": "copy",
  "codex-custom-cursor": "cursor",
  "codex-custom-file": "file",
  "codex-custom-collapse-all": "collapse-all",
  "codex-custom-diff-split": "diff-split",
  "codex-custom-diff-unified": "diff-unified",
  "codex-custom-expand-all": "expand-all",
  "codex-custom-folder": "folder",
  "codex-custom-folder-open": "folder-open",
  "codex-custom-magnifying-glass": "magnifying-glass",
  "codex-custom-magnifying-glass-menu": "magnifying-glass-menu",
  "codex-custom-marketplace": "marketplace",
  "codex-custom-mcp": "mcp",
  "codex-custom-models": "models",
  "codex-custom-three-dots": "three-dots",
  "codex-custom-openai": "openai",
  "codex-custom-opencode": "opencode",
  "codex-custom-panel-restore": "panel-restore",
  "codex-custom-page-plus": "page-plus",
  "codex-custom-pi": "pi",
  "codex-custom-providers": "providers",
  "codex-custom-send": "send",
  "codex-custom-stop": "stop",
  "codex-custom-worktree": "worktree",
  // Deliberately Record, not Partial<Record>. Every `codex-custom-*` name in
  // CodexGlyphName must be drawn here: a missing entry would fall through to
  // `${codexIconSprite}#codex-custom-x`, which the extracted sprite does not
  // contain, and render an invisible icon with no error anywhere.
} as const satisfies Record<CodexCustomGlyph, keyof typeof claxedoIcons>

/**
 * One element per glyph: the `<svg>` IS the icon.
 *
 * `bare` is not "without the wrapper" any more — there is no wrapper. It selects
 * the COMPACT size scale (14/16/18/20 px, written as presentation attributes)
 * and leaves off the `data-component="icon"` / `data-size` grammar, so a `bare`
 * glyph is styled only by what its call site and its container say. The default
 * scale is the shared primitive's (16/20/24/24 px), which `[data-size]` in
 * `@opencode-ai/ui`'s icon.css owns — see the cascade note there for why that
 * sizing must stay in `@layer components`.
 */
function CodexGlyph(props: ClaxedoIconProps & { bare?: boolean }) {
  const [local, others] = splitProps(props, ["name", "size", "class", "classList", "bare", "library"])
  const glyph = () => codexIconLibrary.resolve(local.name)
  const custom = () => customGlyph(glyph())
  createEffect(() => {
    ensureSprite()
    if (!custom()) codexIconSprite.ensure(glyph())
  })
  const size = () => {
    if (local.size === "small") return 14
    if (local.size === "large") return 20
    if (local.size === "medium") return 18
    return 16
  }

  return (
    <svg
      data-component={local.bare ? undefined : "icon"}
      data-slot="icon-svg"
      data-icon={local.name}
      data-library="codex"
      data-size={local.bare ? undefined : local.size || "normal"}
      classList={{
        // Style hook twins of the two data attributes above. The stylesheets
        // match the class, not the attribute, so Blink buckets these rules by
        // class name instead of piling them all into the one `data-slot`
        // attribute bucket that every slotted element in the document pays for.
        // `ui-icon` mirrors `data-component` exactly, including its absence on a
        // `bare` icon.
        "ui-icon": !local.bare,
        "ui-icon-svg": true,
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
      width={local.bare ? size() : undefined}
      height={local.bare ? size() : undefined}
      fill="none"
      viewBox="0 0 20 20"
      aria-hidden={others["aria-hidden"] ?? "true"}
      {...others}
    >
      <use
        href={custom() ? `#${symbol(custom()!)}` : codexIconSprite.href(glyph())}
        transform={codexTransform(local.name)}
      />
    </svg>
  )
}

/** Everything but `name`, which the fallback resolves into the upstream set. */
function upstreamProps(props: ClaxedoIconProps) {
  const [, others] = splitProps(props, ["name", "library"])
  return others
}

export function ClaxedoIcon(props: ClaxedoIconProps) {
  const upstream = () => upstreamProps(props)
  return (
    <Show
      when={resolveIconArtworkLibrary(props.name, props.library ?? iconLibrary()) === "codex"}
      fallback={<UpstreamIcon {...upstream()} name={openCodeIconLibrary.resolve(props.name)} />}
    >
      <CodexGlyph {...props} />
    </Show>
  )
}

export function ClaxedoIconV2(props: ClaxedoIconProps) {
  const upstream = () => upstreamProps(props)
  return (
    <Show
      when={resolveIconArtworkLibrary(props.name, props.library ?? iconLibrary()) === "codex"}
      fallback={<UpstreamIcon {...upstream()} name={openCodeIconLibrary.resolve(props.name)} />}
    >
      <CodexGlyph {...props} bare />
    </Show>
  )
}

function customGlyph(name: CodexGlyphName) {
  const glyphs: Partial<Record<CodexGlyphName, string>> = customGlyphs
  return glyphs[name]
}

function codexTransform(name: AppIconName) {
  const transforms: Partial<Record<AppIconName, string>> = CODEX_ICON_TRANSFORMS
  return transforms[name]
}
