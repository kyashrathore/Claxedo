import { onMount, splitProps, type ComponentProps } from "solid-js"
// ⚠️ Licence risk — see the note in
// `packages/ui/src/components/codex-icons.tsx`. The Codex branch of this
// component renders artwork extracted from the proprietary ChatGPT desktop app.
// Known and accepted for now; the "opencode" branch below is the clean fallback.
import { OpenCodeIcon as UpstreamIcon, type IconProps as UpstreamIconProps } from "@opencode-ai/ui/icon"
import { codexIconSprite } from "@opencode-ai/ui/codex-icons"
import { ACTIVE_ICON_LIBRARY } from "@/ui/icons/config"
import type { AppIconName } from "@/ui/icons/catalog"
import {
  CODEX_ICON_TRANSFORMS,
  codexIconLibrary,
  type CodexCustomGlyph,
  type CodexGlyphName,
} from "@/ui/icons/codex"
import { openCodeIconLibrary } from "@/ui/icons/opencode"

const claxedoIcons = {
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
  pin: `<path d="M6.667 10.417H13.333M8.333 10.417V5H11.667V10.417M10 10.417V16.667" stroke="currentColor" stroke-linecap="square"/>`,
  "pin-filled": `<path d="m8.69891 2.27336c.61298-.91267 1.85279-1.04591 2.67379-.40625l.1582.13867.003.00195 2.4433 2.41504.002.00195c.4266.42675.5579.99704.499 1.50586-.0582.50163-.3073 1.00104-.7187 1.31836l-.0069.00586-.0078.00586-2.415 1.72461c-.1659.11864-.2814.29628-.3223.49609l-.5293 2.59084-.0029.0166-.0039.0156c-.1932.7147-.70508 1.2981-1.36526 1.5254-.68313.2349-1.44732.0609-2.04883-.585l-1.69336-1.6679-2.99316 2.9941c-.20505.2047-.53727.2049-.74219 0-.2047-.2049-.20464-.5372 0-.7422l2.98731-2.9883-1.59571-1.57125c-.58829-.57126-.78754-1.34847-.59179-2.04199.19649-.69522.77364-1.25029 1.60644-1.41308l2.48047-.57227c.19499-.04517.367-.16097.48145-.3252z" fill="currentColor"/>`,
  kebab: `<circle cx="10" cy="5" r="2" fill="currentColor"/><circle cx="10" cy="10" r="2" fill="currentColor"/><circle cx="10" cy="15" r="2" fill="currentColor"/>`,
  // Navigation marks. The extracted sprite has no distinct glyph for any of
  // these three, so all three used to alias codex-20-123 — one sparkle standing
  // in for Marketplace, Models and Providers at once, which made the Settings
  // tab list unreadable. Drawn locally instead: a shop bag, a sparkle, and a
  // chip. Geometry matches the same three names in the upstream `icons` table in
  // `packages/ui/src/components/icon.tsx`, so a callsite renders the same mark
  // whichever component it reaches for.
  marketplace: `<path d="M5 6.66667H15L14.1667 16.25H5.83333L5 6.66667Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M7.5 6.66667V5C7.5 3.61929 8.61929 2.5 10 2.5C11.3807 2.5 12.5 3.61929 12.5 5V6.66667" stroke="currentColor" stroke-linecap="round"/>`,
  models: `<path fill-rule="evenodd" clip-rule="evenodd" d="M17.5 10C12.2917 10 10 12.2917 10 17.5C10 12.2917 7.70833 10 2.5 10C7.70833 10 10 7.70833 10 2.5C10 7.70833 12.2917 10 17.5 10Z" stroke="currentColor"/>`,
  providers: `<path d="M10.0001 4.37562V2.875M13 4.37793V2.87793M7.00014 4.37793V2.875M10 17.1279V15.6279M13 17.1279V15.6279M7 17.1279V15.6279M15.625 13.0029H17.125M15.625 7.00293H17.125M15.625 10.0029H17.125M2.875 10.0029H4.375M2.875 13.0029H4.375M2.875 7.00293H4.375M4.375 4.37793H15.625V15.6279H4.375V4.37793ZM12.6241 10.0022C12.6241 11.4519 11.4488 12.6272 9.99908 12.6272C8.54934 12.6272 7.37408 11.4519 7.37408 10.0022C7.37408 8.55245 8.54934 7.3772 9.99908 7.3772C11.4488 7.3772 12.6241 8.55245 12.6241 10.0022Z" stroke="currentColor" stroke-linecap="square"/>`,
  "more-horizontal": `<circle cx="5" cy="10" r="1.6" fill="currentColor"/><circle cx="10" cy="10" r="1.6" fill="currentColor"/><circle cx="15" cy="10" r="1.6" fill="currentColor"/>`,
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
  "panel-expand": `<path d="M4.33496 11C4.33496 10.6327 4.63273 10.335 5 10.335C5.36727 10.335 5.66504 10.6327 5.66504 11V14.335H9L9.13379 14.3486C9.43692 14.4106 9.66504 14.6786 9.66504 15C9.66504 15.3214 9.43692 15.5894 9.13379 15.6514L9 15.665H5C4.63273 15.665 4.33496 15.3673 4.33496 15V11ZM14.335 9V5.66504H11C10.6327 5.66504 10.335 5.36727 10.335 5C10.335 4.63273 10.6327 4.33496 11 4.33496H15L15.1338 4.34863C15.4369 4.41057 15.665 4.67857 15.665 5V9C15.665 9.36727 15.3673 9.66504 15 9.66504C14.6327 9.66504 14.335 9.36727 14.335 9Z" fill="currentColor"/>`,
  "panel-restore": `<g transform="scale(1.25)"><path d="M6.1664 8.80845C6.7325 8.80845 7.1918 9.26774 7.1918 9.83384V13.3338C7.19155 13.6236 6.9562 13.8592 6.6664 13.8592C6.37672 13.8591 6.14126 13.6235 6.14101 13.3338V10.5936L2.70547 14.0379C2.50071 14.243 2.16753 14.2435 1.9623 14.0389C1.75709 13.8342 1.75665 13.501 1.96133 13.2957L5.39101 9.85923H2.6664C2.37672 9.85909 2.14126 9.6235 2.14101 9.33384C2.14101 9.04397 2.37657 8.80858 2.6664 8.80845H6.1664Z" fill="currentColor"/><path d="M13.2943 1.96274C13.4989 1.75743 13.8311 1.75731 14.0365 1.96177C14.2419 2.16637 14.243 2.49854 14.0385 2.70395L10.6127 6.14145H13.3334C13.6233 6.14145 13.8588 6.37689 13.8588 6.66684C13.8587 6.95674 13.6233 7.19223 13.3334 7.19223H9.8334C9.26734 7.19223 8.80807 6.73288 8.80801 6.16684V2.66684C8.80801 2.37689 9.04345 2.14145 9.3334 2.14145C9.62335 2.14145 9.85879 2.37689 9.85879 2.66684V5.41098L13.2943 1.96274Z" fill="currentColor"/></g>`,
  "expand-all": `<path d="M6 8V3.5M6 3.5L3.75 5.75M6 3.5L8.25 5.75M6 12V16.5M6 16.5L3.75 14.25M6 16.5L8.25 14.25M10.5 6.5H16M10.5 10H14.5M10.5 13.5H16" stroke="currentColor" stroke-width="1.33" stroke-linecap="round" stroke-linejoin="round"/>`,
  "collapse-all": `<path d="M6 3.5V8M6 8L3.75 5.75M6 8L8.25 5.75M6 16.5V12M6 12L3.75 14.25M6 12L8.25 14.25M10.5 6.5H16M10.5 10H14.5M10.5 13.5H16" stroke="currentColor" stroke-width="1.33" stroke-linecap="round" stroke-linejoin="round"/>`,
  "diff-split": `<rect x="3" y="4" width="14" height="12" rx="2" stroke="currentColor" stroke-width="1.25"/><path d="M10 4.75V15.25" stroke="currentColor" stroke-width="1"/><rect x="4.75" y="6" width="3.5" height="8" rx="0.75" fill="var(--text-diff-delete-base)"/><rect x="11.75" y="6" width="3.5" height="8" rx="0.75" fill="var(--text-diff-add-base)"/>`,
  "diff-unified": `<rect x="3" y="4" width="14" height="12" rx="2" stroke="currentColor" stroke-width="1.25"/><path d="M3.75 10H16.25" stroke="currentColor" stroke-width="1"/><rect x="5" y="5.75" width="10" height="2.5" rx="0.75" fill="var(--text-diff-delete-base)"/><rect x="5" y="11.75" width="10" height="2.5" rx="0.75" fill="var(--text-diff-add-base)"/>`,
  // Monochrome harness marks: Claude, Cursor, OpenAI and Pi use the MIT-licensed
  // LobeHub geometry; OpenCode uses its official brand/provider geometry.
  // They are authored on a 0 0 24 24 grid. Rather than scale to fill the sprite
  // (20/24 → edge-to-edge), we scale the 24-unit art down to ~14 units and
  // centre it (translate 3). These logos are dense and *filled*, so at full
  // size they read much heavier than the thin line glyphs beside them (+, ›,
  // chevron); the extra padding brings their perceived size into line.
  // Filled with currentColor so they inherit the toolbar's idle/hover color.
  claude: `<g transform="translate(3 3) scale(0.583333)"><path fill="currentColor" fill-rule="evenodd" d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/></g>`,
  cursor: `<g transform="translate(3 3) scale(0.583333)"><path fill="currentColor" fill-rule="evenodd" d="M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z"/></g>`,
  openai: `<g transform="translate(3 3) scale(0.583333)"><path fill="currentColor" fill-rule="evenodd" d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"/></g>`,
  // The official 24px source includes its own four-unit horizontal inset.
  // Scale that source to a 12×15px optical mark inside the 20px slot: smaller
  // than its former full-height rendering, but not the tiny 8px square produced
  // by treating the source's built-in whitespace as visible geometry.
  opencode: `<g transform="translate(1 1) scale(0.75)"><path d="M16 6H8V18H16V6ZM20 22H4V2H20V22Z" fill="currentColor"/></g>`,
  pi: `<g transform="translate(3 3) scale(0.583333)"><path fill="currentColor" fill-rule="evenodd" d="M1 1h16.5v11H12v5.5H6.5V23H1V1zm5.5 5.5V12H12V6.5H6.5z"/><path d="M17.5 12H23v11h-5.5V12z" fill="currentColor"/></g>`,
}

export type ClaxedoIconName = AppIconName

export interface ClaxedoIconProps extends Omit<ComponentProps<"svg">, "name"> {
  name: ClaxedoIconName
  size?: "small" | "normal" | "medium" | "large"
}

const spriteID = "claxedo-icon-sprite"
const symbol = (name: keyof typeof claxedoIcons) => `claxedo-icon-${name}`
let spriteInserted = false

function ensureSprite() {
  if (spriteInserted) return
  if (typeof document === "undefined") return
  const markup = Object.entries(claxedoIcons)
    .map(([name, path]) => `<symbol id="${symbol(name as keyof typeof claxedoIcons)}" viewBox="0 0 20 20">${path}</symbol>`)
    .join("")
  const existing = document.getElementById(spriteID)
  if (existing) {
    // The sprite survives Vite HMR in document.body. Refresh its symbols when
    // this module reloads so changed shared glyphs do not retain stale paths.
    existing.innerHTML = markup
    spriteInserted = true
    return
  }
  const body = document.body as HTMLElement | null
  if (!body) return

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.id = spriteID
  svg.setAttribute("aria-hidden", "true")
  svg.setAttribute("width", "0")
  svg.setAttribute("height", "0")
  svg.style.position = "absolute"
  svg.style.overflow = "hidden"
  svg.innerHTML = markup
  body.insertBefore(svg, body.firstChild)
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
  "codex-custom-kebab": "kebab",
  "codex-custom-magnifying-glass": "magnifying-glass",
  "codex-custom-magnifying-glass-menu": "magnifying-glass-menu",
  "codex-custom-marketplace": "marketplace",
  "codex-custom-mcp": "mcp",
  "codex-custom-models": "models",
  "codex-custom-more-horizontal": "more-horizontal",
  "codex-custom-openai": "openai",
  "codex-custom-opencode": "opencode",
  "codex-custom-panel-expand": "panel-expand",
  "codex-custom-panel-restore": "panel-restore",
  "codex-custom-page-plus": "page-plus",
  "codex-custom-pin": "pin",
  "codex-custom-pin-filled": "pin-filled",
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

function CodexGlyph(props: ClaxedoIconProps & { bare?: boolean }) {
  const [local, others] = splitProps(props, ["name", "size", "class", "classList", "bare"])
  onMount(ensureSprite)
  const glyph = () => codexIconLibrary.resolve(local.name)
  const custom = () => customGlyph(glyph())
  const size = () => {
    if (local.size === "small") return 14
    if (local.size === "large") return 20
    if (local.size === "medium") return 18
    return 16
  }
  const svg = () => (
    <svg
      data-slot="icon-svg"
      classList={{
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
        href={custom() ? `#${symbol(custom()!)}` : `${codexIconSprite}#${glyph()}`}
        transform={codexTransform(local.name)}
      />
    </svg>
  )

  if (local.bare) return svg()

  return (
    <div data-component="icon" data-icon={local.name} data-library="codex" data-size={local.size || "normal"}>
      {svg()}
    </div>
  )
}

export function ClaxedoIcon(props: ClaxedoIconProps) {
  if (ACTIVE_ICON_LIBRARY === "opencode") {
    return <UpstreamIcon {...props as UpstreamIconProps} name={openCodeIconLibrary.resolve(props.name)} />
  }
  return <CodexGlyph {...props} />
}

export function ClaxedoIconV2(props: ClaxedoIconProps) {
  if (ACTIVE_ICON_LIBRARY === "opencode") {
    return <UpstreamIcon {...props as UpstreamIconProps} name={openCodeIconLibrary.resolve(props.name)} />
  }
  return <CodexGlyph {...props} bare />
}

function customGlyph(name: CodexGlyphName) {
  if (name in customGlyphs) return customGlyphs[name as keyof typeof customGlyphs]
}

function codexTransform(name: AppIconName) {
  if (name in CODEX_ICON_TRANSFORMS) {
    return CODEX_ICON_TRANSFORMS[name as keyof typeof CODEX_ICON_TRANSFORMS]
  }
}
