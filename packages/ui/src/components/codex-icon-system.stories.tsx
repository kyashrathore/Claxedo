// @ts-nocheck
import { createMemo, createSignal, For } from "solid-js"
import sprite from "../assets/icons/codex/sprite.svg"
import manifest from "../assets/icons/codex/manifest.json"
import "./codex-icon-system.stories.css"

const sizes = [
  ["3xs", 10],
  ["xxs", 12],
  ["2xs", 14],
  ["xs", 16],
  ["sm", 18],
  ["base", 20],
  ["md", 24],
  ["lg", 28],
] as const

const surfaces = [
  ["Underlay", "#161616", "surface-under"],
  ["Canvas", "#181818", "surface"],
  ["Panel", "#232323", "panel"],
  ["Editor", "#282828", "editor-opaque"],
  ["Control", "#2d2d2d", "control-opaque"],
  ["Elevated", "#363636", "elevated-primary"],
] as const

const featureGroups = [
  {
    id: "chrome",
    label: "App chrome & navigation",
    description: "Directional movement, sidebar layout, global actions, composer entry points.",
    range: [1, 35],
  },
  {
    id: "services",
    label: "Services & plugins",
    description: "Provider marks and integration-specific glyphs.",
    range: [36, 46],
  },
  {
    id: "review",
    label: "Review & developer tools",
    description: "Editing, terminal, playback, diffs, uploads, and process controls.",
    range: [47, 90],
  },
  {
    id: "git",
    label: "Git & worktree",
    description: "Branch topology, change review, execution, and worktree actions.",
    range: [91, 105],
  },
  {
    id: "agent",
    label: "Agent & permissions",
    description: "Reasoning, steering, safety, identity, and agent-status glyphs.",
    range: [106, 124],
  },
  {
    id: "system",
    label: "Surfaces, account & system",
    description: "View modes, pinning, notifications, archive, theme, and project state.",
    range: [125, 154],
  },
] as const

const Glyph = (props: { id: string; size?: number; label?: string }) => (
  <svg
    class="codex-glyph"
    width={props.size ?? 18}
    height={props.size ?? 18}
    viewBox="0 0 20 20"
    role={props.label ? "img" : undefined}
    aria-hidden={props.label ? undefined : "true"}
    aria-label={props.label}
  >
    <use href={`${sprite}#${props.id}`} />
  </svg>
)

const ClosedFolderGlyph = (props: { size?: number }) => (
  <svg
    class="codex-glyph codex-inline-glyph"
    width={props.size ?? 16}
    height={props.size ?? 16}
    viewBox="0 0 16 16"
    aria-hidden="true"
  >
    <path d="M5.36914 2.1416C5.92368 2.14164 6.3602 2.23705 6.73242 2.38965C7.09745 2.53934 7.38155 2.73818 7.61816 2.9043C8.07599 3.22573 8.42077 3.47464 9.16602 3.47461H11.9473C13.3336 3.47484 14.4453 4.61217 14.4453 6V7.06543C14.4453 7.07196 14.4435 7.07845 14.4434 7.08496V11.3311C14.4432 12.7187 13.3316 13.8562 11.9453 13.8564H4.05371C2.66747 13.8562 1.55583 12.7187 1.55566 11.3311V7.35059C1.55545 7.34451 1.55377 7.33815 1.55371 7.33203C1.55371 7.32563 1.55539 7.31884 1.55566 7.3125V4.66699C1.55566 3.27918 2.66737 2.14185 4.05371 2.1416H5.36914ZM2.60547 7.85645V11.3311C2.60563 12.1519 3.26037 12.8054 4.05371 12.8057H11.9453C12.7387 12.8054 13.3934 12.1519 13.3936 11.3311V7.85645H2.60547ZM4.05371 3.19238C3.26027 3.19264 2.60547 3.84598 2.60547 4.66699V6.80664H13.3955V6C13.3955 5.17898 12.7407 4.52562 11.9473 4.52539H9.16699C8.07975 4.52558 7.50694 4.10863 7.01562 3.76367C6.77766 3.5966 6.57849 3.46159 6.33398 3.36133C6.09656 3.264 5.79646 3.19242 5.36914 3.19238H4.05371Z" />
  </svg>
)

const OpenFolderGlyph = (props: { size?: number }) => (
  <svg
    class="codex-glyph codex-inline-glyph"
    width={props.size ?? 16}
    height={props.size ?? 16}
    viewBox="0 0 16 16"
    aria-hidden="true"
  >
    <path
      fill-rule="evenodd"
      clip-rule="evenodd"
      d="M4.75488 2.1416C5.30942 2.14164 5.74594 2.23705 6.11816 2.38965C6.48323 2.53934 6.76728 2.73817 7.00391 2.9043L7.02148 2.91699C7.47057 3.23238 7.8162 3.47463 8.55176 3.47461H11.333C12.7194 3.47484 13.8311 4.61217 13.8311 6L13.875 6.38281H13.8594C14.8729 6.38292 15.5982 7.3629 15.3018 8.33203L14.0068 12.5586C13.7703 13.3297 13.0576 13.8563 12.251 13.8564H3.83984C3.4199 13.8564 3.04144 13.7174 2.73828 13.4883L2.67383 13.4346C1.99907 12.9811 1.55577 12.2065 1.55566 11.3311L0.941406 4.66699C0.941406 3.2792 2.05315 2.1419 3.43945 2.1416H4.75488ZM4.7627 7.42969C4.56039 7.42972 4.3807 7.5625 4.32129 7.75586L3.08594 11.7891C2.96123 12.1965 3.18214 12.6072 3.54883 12.7529C3.63476 12.7768 3.74102 12.7958 3.88184 12.8086H12.251C12.5974 12.8085 12.9033 12.5821 13.0049 12.251L14.2998 8.02539C14.3901 7.72947 14.1688 7.42979 13.8594 7.42969H4.7627ZM3.43945 3.19141C2.64724 3.1917 1.99121 3.84481 1.99121 4.66699L2.49316 10.1201L3.32031 7.44922C3.51452 6.81571 4.10008 6.38284 4.7627 6.38281H12.8252L12.7812 6C12.7812 5.22902 12.2045 4.607 11.4795 4.53223L11.333 4.52441H8.55176C8.05756 4.52442 7.64464 4.44062 7.2666 4.2793C6.91453 4.12896 6.6274 3.92345 6.41797 3.77637L6.40039 3.76367C6.16212 3.59639 5.96404 3.46151 5.71973 3.36133C5.54113 3.28812 5.32754 3.2289 5.05176 3.2041L4.75488 3.19141H3.43945Z"
    />
  </svg>
)

const OutlinePinGlyph = (props: { size?: number }) => (
  <svg
    class="codex-glyph codex-inline-glyph"
    width={props.size ?? 16}
    height={props.size ?? 16}
    viewBox="0 0 16 16"
    aria-hidden="true"
  >
    <path
      fill-rule="evenodd"
      clip-rule="evenodd"
      d="m8.69891 2.27345c.61298-.91267 1.85279-1.0459 2.67379-.40625l.1582.13867.003.00196 2.4433 2.41504.002.00195c.4266.42674.5579.99703.499 1.50586-.0582.50163-.3073 1.00104-.7187 1.31836l-.0069.00586-.0078.00586-2.415 1.7246c-.1659.11864-.2814.29628-.3223.4961l-.5293 2.59084-.0029.0166-.0039.0156c-.1932.7147-.70508 1.2981-1.36526 1.5254-.68313.2349-1.44732.0609-2.04883-.585l-1.69336-1.6679-2.99316 2.9941c-.20505.2047-.53727.2049-.74219 0-.2047-.2049-.20464-.5372 0-.7422l2.98731-2.9883-1.59571-1.57125c-.58829-.57126-.78753-1.34848-.59179-2.04199.19649-.69522.77365-1.25029 1.60644-1.41309l2.48047-.57226c.19499-.04518.367-.16098.48145-.3252zm2.02639.4209c-.371-.28905-.90826-.20853-1.15822.16894l-.00684.01075-1.70215 2.44238c-.26325.37786-.65778.64527-1.10644.74902l-2.48047.57227-.01074.00195-.01074.00293c-.46996.08744-.72571.36997-.81055.66992-.07571.26809-.02825.59512.20312.88379l.11133.1211.00293.0039 4.03809 3.9756.00976.0098.00977.0107c.34353.3766.68604.4105.95117.3193.29254-.101.57406-.3851.68848-.7959l.52539-2.57028c.09401-.45959.35861-.86689.74021-1.13965l2.4024-1.71679c.1553-.12183.2834-.34601.3134-.6045.0292-.25251-.0393-.48226-.1962-.64062l-2.4415-2.41211z"
    />
  </svg>
)

const FilledPinGlyph = (props: { size?: number }) => (
  <svg
    class="codex-glyph codex-inline-glyph"
    width={props.size ?? 16}
    height={props.size ?? 16}
    viewBox="0 0 16 16"
    aria-hidden="true"
  >
    <path d="m8.69891 2.27336c.61298-.91267 1.85279-1.04591 2.67379-.40625l.1582.13867.003.00195 2.4433 2.41504.002.00195c.4266.42675.5579.99704.499 1.50586-.0582.50163-.3073 1.00104-.7187 1.31836l-.0069.00586-.0078.00586-2.415 1.72461c-.1659.11864-.2814.29628-.3223.49609l-.5293 2.59084-.0029.0166-.0039.0156c-.1932.7147-.70508 1.2981-1.36526 1.5254-.68313.2349-1.44732.0609-2.04883-.585l-1.69336-1.6679-2.99316 2.9941c-.20505.2047-.53727.2049-.74219 0-.2047-.2049-.20464-.5372 0-.7422l2.98731-2.9883-1.59571-1.57125c-.58829-.57126-.78754-1.34847-.59179-2.04199.19649-.69522.77364-1.25029 1.60644-1.41308l2.48047-.57227c.19499-.04517.367-.16097.48145-.3252z" />
  </svg>
)

const ExpandPanelGlyph = (props: { size?: number }) => (
  <svg
    class="codex-glyph codex-inline-glyph"
    width={props.size ?? 20}
    height={props.size ?? 20}
    viewBox="0 0 20 20"
    aria-hidden="true"
  >
    <path d="M4.33496 11C4.33496 10.6327 4.63273 10.335 5 10.335C5.36727 10.335 5.66504 10.6327 5.66504 11V14.335H9L9.13379 14.3486C9.43692 14.4106 9.66504 14.6786 9.66504 15C9.66504 15.3214 9.43692 15.5894 9.13379 15.6514L9 15.665H5C4.63273 15.665 4.33496 15.3673 4.33496 15V11ZM14.335 9V5.66504H11C10.6327 5.66504 10.335 5.36727 10.335 5C10.335 4.63273 10.6327 4.33496 11 4.33496H15L15.1338 4.34863C15.4369 4.41057 15.665 4.67857 15.665 5V9C15.665 9.36727 15.3673 9.66504 15 9.66504C14.6327 9.66504 14.335 9.36727 14.335 9Z" />
  </svg>
)

const RestorePanelGlyph = (props: { size?: number }) => (
  <svg
    class="codex-glyph codex-inline-glyph"
    width={props.size ?? 16}
    height={props.size ?? 16}
    viewBox="0 0 16 16"
    aria-hidden="true"
  >
    <path d="M6.1664 8.80845C6.7325 8.80845 7.1918 9.26774 7.1918 9.83384V13.3338C7.19155 13.6236 6.9562 13.8592 6.6664 13.8592C6.37672 13.8591 6.14126 13.6235 6.14101 13.3338V10.5936L2.70547 14.0379C2.50071 14.243 2.16753 14.2435 1.9623 14.0389C1.75709 13.8342 1.75665 13.501 1.96133 13.2957L5.39101 9.85923H2.6664C2.37672 9.85909 2.14126 9.6235 2.14101 9.33384C2.14101 9.04397 2.37657 8.80858 2.6664 8.80845H6.1664Z" />
    <path d="M13.2943 1.96274C13.4989 1.75743 13.8311 1.75731 14.0365 1.96177C14.2419 2.16637 14.243 2.49854 14.0385 2.70395L10.6127 6.14145H13.3334C13.6233 6.14145 13.8588 6.37689 13.8588 6.66684C13.8587 6.95674 13.6233 7.19223 13.3334 7.19223H9.8334C9.26734 7.19223 8.80807 6.73288 8.80801 6.16684V2.66684C8.80801 2.37689 9.04345 2.14145 9.3334 2.14145C9.62335 2.14145 9.85879 2.37689 9.85879 2.66684V5.41098L13.2943 1.96274Z" />
  </svg>
)

const statePairs = [
  {
    feature: "Left sidebar",
    first: ["Collapsed", "sidebar-collapsed"],
    second: ["Expanded", "sidebar-expanded"],
    behavior: "Swap glyph",
  },
  {
    feature: "Right side panel",
    first: ["Collapsed", "right-collapsed"],
    second: ["Expanded", "right-expanded"],
    behavior: "Mirror + swap",
  },
  {
    feature: "Review panel",
    first: ["Expand panel", "panel-expand"],
    second: ["Restore width", "panel-restore"],
    behavior: "Swap glyph",
  },
  {
    feature: "Project folder",
    first: ["Closed", "folder-closed"],
    second: ["Open", "folder-open"],
    behavior: "Swap glyph",
  },
  {
    feature: "Pinning",
    first: ["Unpinned · hover only", "pin-outline"],
    second: ["Pinned · persistent", "pin-filled"],
    behavior: "Swap + persist",
  },
  {
    feature: "Task execution",
    first: ["Run", "codex-20-068"],
    second: ["Stop", "codex-20-005"],
    behavior: "Swap glyph",
  },
] as const

const FeatureGlyph = (props: { kind: string }) => {
  if (props.kind === "folder-closed") return <ClosedFolderGlyph size={20} />
  if (props.kind === "folder-open") return <OpenFolderGlyph size={20} />
  if (props.kind === "pin-outline") return <OutlinePinGlyph size={20} />
  if (props.kind === "pin-filled") return <FilledPinGlyph size={20} />
  if (props.kind === "panel-expand") return <ExpandPanelGlyph size={20} />
  if (props.kind === "panel-restore") return <RestorePanelGlyph size={20} />
  if (props.kind === "sidebar-collapsed") return <Glyph id="codex-20-034" size={20} />
  if (props.kind === "sidebar-expanded") return <Glyph id="codex-20-035" size={20} />
  if (props.kind === "right-collapsed")
    return (
      <span class="codex-right-panel-glyph">
        <Glyph id="codex-20-034" size={20} label="Right sidebar collapsed" />
      </span>
    )
  if (props.kind === "right-expanded")
    return (
      <span class="codex-right-panel-glyph">
        <Glyph id="codex-20-035" size={20} label="Right sidebar expanded" />
      </span>
    )
  return <Glyph id={props.kind} size={20} />
}

const SurfaceExamples = () => {
  const [folderOpen, setFolderOpen] = createSignal(false)
  return (
    <section class="codex-section" aria-labelledby="surface-heading">
      <div class="codex-section-heading">
        <div>
          <p class="codex-eyebrow">Interaction grammar</p>
          <h2 id="surface-heading">The surface owns the hover behavior</h2>
        </div>
        <p>Hover each example. Click the project row to compare its two glyph states.</p>
      </div>

      <div class="codex-surface-grid">
        <article class="codex-demo codex-sidebar-demo">
          <div class="codex-demo-title">
            <span>Persistent navigation</span>
            <code>background-only hover</code>
          </div>
          <nav aria-label="Navigation example">
            <button class="codex-nav-row">
              <Glyph id="codex-20-019" size={18} />
              <span>New chat</span>
            </button>
            <button class="codex-nav-row">
              <Glyph id="codex-20-037" size={18} />
              <span>Pull requests</span>
            </button>
            <button class="codex-nav-row codex-selected-row">
              <Glyph id="codex-20-105" size={18} />
              <span>Plugins</span>
            </button>
          </nav>
        </article>

        <article class="codex-demo codex-context-demo">
          <div class="codex-demo-title">
            <span>Context card</span>
            <code>primary action rows</code>
          </div>
          <div class="codex-card-heading">
            <span>Environment</span>
            <button class="codex-heading-action" aria-label="Add environment">
              <Glyph id="codex-20-006" size={18} />
            </button>
          </div>
          <button class="codex-context-row">
            <Glyph id="codex-20-120" size={18} />
            <span>Changes</span>
            <span class="codex-diff-positive">+5,427</span>
            <span class="codex-diff-negative">−582</span>
          </button>
          <button class="codex-context-row">
            <Glyph id="codex-20-131" size={18} />
            <span>Worktree</span>
          </button>
          <button class="codex-context-row">
            <Glyph id="codex-20-037" size={18} />
            <span>Create branch</span>
          </button>
        </article>

        <article class="codex-demo codex-menu-demo">
          <div class="codex-demo-title">
            <span>Menu accessory icons</span>
            <code>75% → 100%</code>
          </div>
          <div class="codex-menu" role="menu">
            <button class="codex-menu-row" role="menuitem">
              <Glyph id="codex-20-105" size={16} />
              <span>Refresh</span>
            </button>
            <button class="codex-menu-row" role="menuitem">
              <Glyph id="codex-20-112" size={16} />
              <span>Enable word wrap</span>
            </button>
            <div class="codex-separator" />
            <button class="codex-menu-row" role="menuitem">
              <Glyph id="codex-20-124" size={16} />
              <span>Enable rich preview</span>
            </button>
          </div>
        </article>

        <article class="codex-demo codex-state-demo">
          <div class="codex-demo-title">
            <span>Stateful and revealed actions</span>
            <code>glyph carries state</code>
          </div>
          <button class="codex-project-row" onClick={() => setFolderOpen((value) => !value)}>
            {folderOpen() ? <OpenFolderGlyph size={18} /> : <ClosedFolderGlyph size={18} />}
            <span>opencode</span>
            <span class="codex-row-actions">
              <span class="codex-row-action" aria-label="Pin project">
                <OutlinePinGlyph size={16} />
              </span>
              <span class="codex-row-action" aria-label="More actions">
                <Glyph id="codex-20-144" size={16} />
              </span>
            </span>
          </button>
          <div class="codex-state-note">
            <span>{folderOpen() ? "Open glyph" : "Closed glyph"}</span>
            <span>Row action is hidden at rest, revealed dim, then brightens by tint only.</span>
          </div>
        </article>
      </div>
    </section>
  )
}

const FeatureStates = () => (
  <section class="codex-section" aria-labelledby="feature-states-heading">
    <div class="codex-section-heading">
      <div>
        <p class="codex-eyebrow">Feature states</p>
        <h2 id="feature-states-heading">State belongs to the feature</h2>
      </div>
      <p>
        Codex swaps glyphs when the silhouette communicates state. A pinned item also changes persistence:
        outline appears on row hover, filled stays visible.
      </p>
    </div>

    <div class="codex-feature-state-grid">
      <For each={statePairs}>
        {(pair) => (
          <article class="codex-feature-state">
            <div class="codex-feature-state-heading">
              <span>{pair.feature}</span>
              <code>{pair.behavior}</code>
            </div>
            <div class="codex-feature-state-pair">
              <div classList={{ "codex-revealed-state": pair.feature === "Pinning" }}>
                <FeatureGlyph kind={pair.first[1]} />
                <span>{pair.first[0]}</span>
              </div>
              <Glyph id="codex-20-001" size={12} />
              <div classList={{ "codex-persistent-state": pair.feature === "Pinning" }}>
                <FeatureGlyph kind={pair.second[1]} />
                <span>{pair.second[0]}</span>
              </div>
            </div>
          </article>
        )}
      </For>
    </div>
  </section>
)

const StateContract = (props: {
  kind: "stable" | "reveal" | "standalone" | "menu"
  label: string
  note: string
}) => (
  <div class={`codex-contract codex-contract-${props.kind}`}>
    <span class="codex-contract-parent">
      <span class="codex-contract-icon">
        <Glyph id="codex-20-130" size={17} />
      </span>
      <span>{props.label}</span>
      {props.kind === "reveal" ? (
        <span class="codex-contract-action">
          <OutlinePinGlyph size={16} />
        </span>
      ) : null}
    </span>
    <small>{props.note}</small>
  </div>
)

const BackgroundStates = () => {
  const backgrounds = [
    ["Canvas", "#181818", "page"],
    ["Sidebar", "#232323", "navigation"],
    ["Control", "#2d2d2d", "card"],
    ["Elevated", "#363636", "menu"],
  ] as const
  return (
    <section class="codex-section" aria-labelledby="background-states-heading">
      <div class="codex-section-heading">
        <div>
          <p class="codex-eyebrow">State contract × surface</p>
          <h2 id="background-states-heading">The same glyph behaves differently by owner</h2>
        </div>
        <p>Hover the row, then the trailing pin. It appears with the row and only its tint brightens directly.</p>
      </div>

      <div class="codex-background-grid">
        <For each={backgrounds}>
          {([label, value, role]) => (
            <article class="codex-background-sample" style={{ "--codex-sample-background": value }}>
              <div class="codex-background-heading">
                <span>{label}</span>
                <code>{role} · {value}</code>
              </div>
              <StateContract kind="stable" label="Stable row icon" note="Always visible · row owns hover fill" />
              <StateContract kind="reveal" label="Hover-revealed pin" note="hidden → dim → bright; no nested fill" />
              <StateContract kind="standalone" label="Stateless icon button" note="Icon tone fixed · button gets fill" />
              <StateContract kind="menu" label="Menu accessory" note="75% → 100% with row hover" />
            </article>
          )}
        </For>
      </div>
    </section>
  )
}

const Tokens = () => (
  <section class="codex-section" aria-labelledby="tokens-heading">
    <div class="codex-section-heading">
      <div>
        <p class="codex-eyebrow">Verified tokens</p>
        <h2 id="tokens-heading">A small palette, composed in layers</h2>
      </div>
      <p>Names and values are taken from the installed Codex renderer.</p>
    </div>

    <div class="codex-token-layout">
      <article class="codex-token-panel">
        <h3>Background ladder</h3>
        <div class="codex-swatch-list">
          <For each={surfaces}>
            {([label, value, token]) => (
              <div class="codex-swatch-row">
                <span class="codex-swatch" style={{ background: value }} />
                <span>{label}</span>
                <code>--color-background-{token}</code>
                <span class="codex-value">{value}</span>
              </div>
            )}
          </For>
        </div>
      </article>

      <article class="codex-token-panel">
        <h3>Foreground hierarchy</h3>
        <div class="codex-type-samples">
          <div class="codex-text-primary">
            Primary <code>foreground / icon-primary</code>
          </div>
          <div class="codex-text-secondary">
            Secondary <code>71% / icon-secondary</code>
          </div>
          <div class="codex-text-tertiary">
            Tertiary <code>50% / icon-tertiary</code>
          </div>
        </div>
        <div class="codex-state-colors">
          <span class="codex-diff-positive">Success · #40c977</span>
          <span class="codex-diff-negative">Error · #fa423e</span>
          <span class="codex-accent">Accent · #339cff</span>
          <span class="codex-skill">Skill · #ad7bf9</span>
        </div>
      </article>

      <article class="codex-token-panel codex-size-panel">
        <h3>Eight display sizes</h3>
        <div class="codex-size-list">
          <For each={sizes}>
            {([name, value]) => (
              <div class="codex-size-item">
                <span class="codex-size-stage">
                  <Glyph id="codex-20-001" size={value} />
                </span>
                <code>icon-{name}</code>
                <span>{value}px</span>
              </div>
            )}
          </For>
        </div>
      </article>
    </div>
  </section>
)

const Gallery = () => {
  const [query, setQuery] = createSignal("")
  const [feature, setFeature] = createSignal("all")
  const visibleGroups = createMemo(() => {
    const value = query().trim().toLowerCase()
    return featureGroups
      .filter((group) => feature() === "all" || feature() === group.id)
      .map((group) => ({
        ...group,
        icons: manifest.icons.filter((icon) => {
          const number = Number(icon.id.replace("codex-20-", ""))
          if (number < group.range[0] || number > group.range[1]) return false
          if (!value) return true
          return (
            icon.id.includes(value) ||
            icon.hash.includes(value) ||
            icon.sourceSymbol?.toLowerCase().includes(value)
          )
        }),
      }))
      .filter((group) => group.icons.length > 0)
  })
  const visibleCount = createMemo(() => visibleGroups().reduce((total, group) => total + group.icons.length, 0))

  return (
    <section class="codex-section" aria-labelledby="gallery-heading">
      <div class="codex-section-heading codex-gallery-heading">
        <div>
          <p class="codex-eyebrow">Extracted inventory</p>
          <h2 id="gallery-heading">154 components · 150 unique geometries</h2>
        </div>
        <label class="codex-search">
          <span class="codex-visually-hidden">Filter extracted icons</span>
          <Glyph id="codex-20-028" size={16} />
          <input
            type="search"
            placeholder="Filter ID, hash, or source symbol"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          <span>{visibleCount()}</span>
        </label>
      </div>

      <div class="codex-feature-tabs" role="toolbar" aria-label="Filter by feature family">
        <button classList={{ active: feature() === "all" }} onClick={() => setFeature("all")}>
          All <span>154</span>
        </button>
        <For each={featureGroups}>
          {(group) => (
            <button classList={{ active: feature() === group.id }} onClick={() => setFeature(group.id)}>
              {group.label} <span>{group.range[1] - group.range[0] + 1}</span>
            </button>
          )}
        </For>
      </div>

      <div class="codex-feature-groups">
        <For each={visibleGroups()}>
          {(group) => (
            <section class="codex-feature-group" aria-labelledby={`feature-${group.id}`}>
              <div class="codex-feature-group-heading">
                <div>
                  <h3 id={`feature-${group.id}`}>{group.label}</h3>
                  <p>{group.description}</p>
                </div>
                <span>{group.icons.length}</span>
              </div>
              <div class="codex-gallery">
                <For each={group.icons}>
                  {(icon) => (
                    <button
                      class="codex-icon-cell"
                      title={`${icon.id} · ${icon.hash}${icon.sourceSymbol ? ` · ${icon.sourceSymbol}` : ""}`}
                      onClick={() => navigator.clipboard?.writeText(icon.id)}
                    >
                      <span class="codex-icon-stage">
                        <Glyph id={icon.id} size={20} />
                      </span>
                      <code>{icon.id.replace("codex-20-", "")}</code>
                      {icon.duplicateOf ? <span class="codex-duplicate">duplicate</span> : null}
                    </button>
                  )}
                </For>
              </div>
            </section>
          )}
        </For>
        {visibleCount() === 0 ? (
          <div class="codex-empty-state">
            <Glyph id="codex-20-028" size={20} />
            <span>No extracted icon matches this filter.</span>
          </div>
        ) : null}
      </div>
    </section>
  )
}

const Reference = () => (
  <main class="codex-reference">
    <header class="codex-hero">
      <div>
        <p class="codex-eyebrow">Codex desktop · build 5848</p>
        <h1>Icon system reference</h1>
        <p>
          Custom OpenAI SVG geometry, eight display sizes, three neutral foreground tiers, and interaction
          behavior determined by the containing surface.
        </p>
      </div>
      <div class="codex-hero-mark">
        <Glyph id="codex-20-001" size={28} />
        <span>20×20 source canvas</span>
      </div>
    </header>
    <SurfaceExamples />
    <FeatureStates />
    <BackgroundStates />
    <Tokens />
    <Gallery />
  </main>
)

export default {
  title: "Reference/Codex Icon System",
  id: "reference-codex-icon-system",
  parameters: {
    layout: "fullscreen",
    themes: { themeOverride: "dark" },
    docs: {
      description: {
        component:
          "A visual audit of the icon geometry, size scale, foreground hierarchy, background ladder, dropdown treatment, and surface-specific interaction states verified from the installed Codex desktop renderer.",
      },
    },
  },
}

export const CompleteReference = {
  render: () => <Reference />,
}
