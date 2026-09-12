import { resolveIconArtworkLibrary } from "./icon-artwork-policy"
import { iconMappingUsage } from "../storybook/icon-mapping-usage"
// Codex extraction provenance lives in ./codex-icons.tsx and its asset manifest.
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import sprite from "../assets/icons/codex/sprite.svg"
import manifest from "../assets/icons/codex/manifest.json"
import { openCodeIconNames, getOpenCodeIconArtwork, iconLibraryPreference, setIconLibraryPreference } from "./icon"
import { ClaxedoIcon } from "@/ui/controls/claxedo-icon"
import { appIconNames, type AppIconName } from "@/ui/icons/catalog"
import { codexIconLibrary } from "@/ui/icons/codex"
import { openCodeIconLibrary } from "@/ui/icons/opencode"
import openCodeSprite from "../assets/icons/opencode/sprite.svg?url"
import openCodeManifest from "../assets/icons/opencode/manifest.json?url"
import { iconMappingAudit } from "../storybook/icon-mapping-audit"
import { getOpenCodeV2IconArtwork, openCodeV2IconNames } from "../v2/components/icon"
import openCodeV2Sprite from "../assets/icons/opencode-v2/sprite.svg?url"
import openCodeV2Manifest from "../assets/icons/opencode-v2/manifest.json?url"
import nativeCodexManifest from "../assets/icons/codex-alternatives/manifest.json"
import "./codex-icon-system.stories.css"

type Library = "codex" | "opencode"
const libraries = ["codex", "opencode"] as const
const libraryLabel = { codex: "Codex", opencode: "OpenCode · other themes" }
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
    description: "Movement, layout and global actions.",
    range: [1, 35],
  },
  { id: "services", label: "Services & plugins", description: "Provider marks and integrations.", range: [36, 46] },
  {
    id: "review",
    label: "Review & developer tools",
    description: "Terminal, diffs and process controls.",
    range: [47, 90],
  },
  { id: "git", label: "Git & worktree", description: "Branch topology and checkout actions.", range: [91, 105] },
  { id: "agent", label: "Agent & permissions", description: "Reasoning, steering and status.", range: [106, 124] },
  {
    id: "system",
    label: "Surfaces, account & system",
    description: "View modes, pinning and project state.",
    range: [125, 154],
  },
] as const

const Glyph = (props: { id: string; size?: number }) => (
  <svg class="codex-glyph" width={props.size ?? 18} height={props.size ?? 18} viewBox="0 0 20 20" aria-hidden="true">
    <use href={`${sprite}#${props.id}`} />
  </svg>
)

/** Both columns use real artwork. Their interaction shell below is the proposed shared contract. */
const CompareGlyph = (props: { library: Library; name: AppIconName; size?: number }) => (
  <span class="icon-reference-glyph" style={{ "--preview-icon-size": `${props.size ?? 20}px` }}>
    <ClaxedoIcon name={props.name} library={props.library} />
  </span>
)

type PatternKind =
  "action" | "row" | "persistent" | "temporary" | "presentation" | "navigation" | "text" | "menu" | "passive"
type Pattern = {
  id: string
  label: string
  kind: PatternKind
  icon: AppIconName
  alternate?: AppIconName
  off: string
  on: string
  rule: string
}
const patterns: Pattern[] = [
  {
    id: "create-terminal",
    label: "Standalone action",
    kind: "action",
    icon: "terminal",
    off: "Create terminal",
    on: "Create terminal",
    rule: "Fixed foreground. Hover and press change the button background.",
  },
  {
    id: "row-action",
    label: "Action inside a row",
    kind: "row",
    icon: "three-dots",
    off: "Project actions",
    on: "Project actions",
    rule: "Hidden → revealed dim → bright on direct hover. The icon has no separate hover background.",
  },
  {
    id: "left-sidebar",
    label: "Persistent layout toggle",
    kind: "persistent",
    icon: "layout-left-partial",
    alternate: "layout-left-full",
    off: "Show sidebar",
    on: "Hide sidebar",
    rule: "Swap glyph on activation. Foreground stays strong in both states.",
  },
  {
    id: "workspace",
    label: "Temporary workspace panel",
    kind: "temporary",
    icon: "layout-right-partial",
    alternate: "layout-right-full",
    off: "Show workspace",
    on: "Hide workspace",
    rule: "Closed is muted; open is strong. Hover changes only the background.",
  },
  {
    id: "terminal",
    label: "Temporary terminal panel",
    kind: "temporary",
    icon: "terminal",
    alternate: "terminal-active",
    off: "Show terminal",
    on: "Hide terminal",
    // Terminal artwork follows the theme; active state changes emphasis.
    rule: "Codex uses its terminal outline; OpenCode uses the bare >_ console prompt. Active state brightens the same mark.",
  },
  {
    id: "folder",
    label: "Project disclosure",
    kind: "persistent",
    icon: "folder",
    alternate: "folder-open",
    off: "Expand project",
    on: "Collapse project",
    rule: "Closed/open artwork represents the current state. Hover does not open the folder.",
  },
  {
    id: "expand-diffs",
    label: "Expand / collapse all",
    kind: "presentation",
    icon: "expand-all",
    alternate: "collapse-all",
    off: "Expand all diffs",
    on: "Collapse all diffs",
    rule: "Show the next action. Both states have equal emphasis; partial expansion offers Expand all.",
  },
  {
    id: "diff-style",
    label: "Unified / split diff",
    kind: "presentation",
    icon: "split",
    alternate: "unified",
    off: "Switch to split diff",
    on: "Switch to unified diff",
    rule: "Show the next mode. Neither presentation mode is brighter than the other.",
  },
  {
    id: "review-panel",
    label: "Workspace panel size",
    kind: "presentation",
    icon: "expand",
    alternate: "collapse",
    off: "Expand workspace panel",
    on: "Restore workspace width",
    rule: "Outward arrows expand; inward arrows restore. Both states use complete arrows in the same hit target.",
  },
  {
    id: "navigation",
    label: "Navigation choice",
    kind: "navigation",
    icon: "folders",
    off: "Files",
    on: "Files",
    rule: "Selection belongs to the destination. The glyph stays fixed; the selected surface persists.",
  },
  {
    id: "text-action",
    label: "Icon with text",
    kind: "text",
    icon: "changes",
    off: "Review changes",
    on: "Review changes",
    rule: "Icon and label share emphasis, hover, pressed and disabled states.",
  },
  {
    id: "menu",
    label: "Menu accessory",
    kind: "menu",
    icon: "reload",
    off: "Refresh",
    on: "Refresh",
    rule: "The whole menu row highlights; the accessory changes from 75% to full opacity.",
  },
  {
    id: "execution",
    label: "Send / stop",
    kind: "presentation",
    icon: "send",
    alternate: "stop",
    off: "Send message",
    on: "Stop response",
    rule: "The available action changes with execution. Stop stays actionable while a response runs.",
  },
  {
    id: "passive",
    label: "Passive / brand icon",
    kind: "passive",
    icon: "claude",
    off: "Claude",
    on: "Claude",
    rule: "No hover, pressed, focus or selected treatment when the mark is not an action.",
  },
]
const states = [
  "rest",
  "parent-hover",
  "hover",
  "pressed",
  "focus",
  "on",
  "on-hover",
  "disabled",
  "disabled-on",
  "loading",
] as const
type PreviewState = (typeof states)[number]
const stateLabel: Record<PreviewState, string> = {
  rest: "Rest",
  "parent-hover": "Parent hover",
  hover: "Hover",
  pressed: "Pressed",
  focus: "Keyboard focus",
  on: "On / alternate",
  "on-hover": "On + hover",
  disabled: "Disabled",
  "disabled-on": "Disabled + on",
  loading: "Pending",
}
const isToggle = (pattern: Pattern) => !!pattern.alternate || pattern.kind === "navigation"
const supportsState = (pattern: Pattern, state: PreviewState) => {
  if (pattern.kind === "passive") return state === "rest" || state === "parent-hover"
  if (state === "parent-hover") return pattern.kind === "row"
  if (state === "on" || state === "on-hover" || state === "disabled-on") return isToggle(pattern)
  // Pending belongs to async commands, not immediate local view changes.
  if (state === "loading") return pattern.kind === "action" || pattern.kind === "text" || pattern.kind === "menu"
  return true
}

const PatternControl = (props: { pattern: Pattern; library: Library; state?: PreviewState; live?: boolean }) => {
  const [on, setOn] = createSignal(false)
  const [activations, setActivations] = createSignal(0)
  const active = () => (props.live ? on() : ["on", "on-hover", "disabled-on"].includes(props.state ?? "rest"))
  const pending = () => props.state === "loading"
  const disabled = () => props.state === "disabled" || props.state === "disabled-on"
  const label = () => (active() ? props.pattern.on : props.pattern.off)
  const icon = () => (active() ? (props.pattern.alternate ?? props.pattern.icon) : props.pattern.icon)
  const attributes = () => ({
    class: "icon-pattern-control",
    "data-kind": props.pattern.kind,
    "data-preview-state": props.live ? undefined : props.state,
    "data-on": active() ? "true" : "false",
  })
  const contents = () => (
    <>
      <Show when={!pending()} fallback={<span class="icon-reference-spinner" aria-hidden="true" />}>
        <CompareGlyph library={props.library} name={icon()} />
      </Show>
      <Show when={["text", "menu", "navigation", "passive"].includes(props.pattern.kind)}>
        <span>{label()}</span>
      </Show>
    </>
  )
  return (
    <div class="icon-pattern-example">
      <div
        class="icon-pattern-row"
        data-kind={props.pattern.kind}
        data-preview-state={props.state}
        data-live={props.live ? "true" : undefined}
      >
        <Show when={props.pattern.kind === "row"}>
          <span class="icon-pattern-row-label">Project</span>
        </Show>
        <Show when={props.pattern.kind !== "passive"} fallback={<span {...attributes()}>{contents()}</span>}>
          <button
            {...attributes()}
            type="button"
            aria-label={`${libraryLabel[props.library]}: ${label()}`}
            aria-pressed={isToggle(props.pattern) ? active() : undefined}
            aria-busy={pending() || undefined}
            aria-disabled={pending() || undefined}
            disabled={disabled()}
            tabIndex={props.live ? 0 : -1}
            onClick={() => {
              if (!props.live || pending()) return
              if (isToggle(props.pattern)) setOn(!on())
              else setActivations(activations() + 1)
            }}
          >
            {contents()}
          </button>
        </Show>
      </div>
      <Show when={props.live && props.pattern.kind !== "passive"}>
        <small aria-live="polite">{isToggle(props.pattern) ? label() : `Activated ${activations()} times`}</small>
      </Show>
    </div>
  )
}

const Lifecycle = () => (
  <section class="codex-section" id="patterns">
    <div class="codex-section-heading">
      <div>
        <p class="codex-eyebrow">Interaction contract · both libraries</p>
        <h2>Every pattern, every applicable state</h2>
      </div>
      <p>
        Static cells make states comparable. Live controls below each table support pointer and keyboard activation. A
        dash means the state does not apply.
      </p>
    </div>
    <For each={patterns}>
      {(pattern) => (
        <article class="icon-pattern" data-pattern={pattern.id}>
          <div class="icon-pattern-heading">
            <h3>{pattern.label}</h3>
            <p>{pattern.rule}</p>
          </div>
          <div class="icon-table-scroll">
            <table class="icon-state-table">
              <thead>
                <tr>
                  <th scope="col">Library</th>
                  <For each={states}>{(state) => <th scope="col">{stateLabel[state]}</th>}</For>
                </tr>
              </thead>
              <tbody>
                <For each={libraries}>
                  {(library) => (
                    <tr>
                      <th scope="row">{libraryLabel[library]}</th>
                      <For each={states}>
                        {(state) => (
                          <td>
                            <Show
                              when={supportsState(pattern, state)}
                              fallback={
                                <span class="icon-not-applicable" aria-label="Not applicable">
                                  —
                                </span>
                              }
                            >
                              <PatternControl pattern={pattern} library={library} state={state} />
                            </Show>
                          </td>
                        )}
                      </For>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
          <div class="icon-live-pair">
            <span>Try it</span>
            <For each={libraries}>
              {(library) => (
                <div>
                  <span class="icon-library-label">{libraryLabel[library]}</span>
                  <PatternControl pattern={pattern} library={library} live />
                </div>
              )}
            </For>
          </div>
        </article>
      )}
    </For>
    <p class="icon-reference-note">
      Press → drag outside → release cancels activation. Hover never commits state. Pointer leave and blur remove only
      their own feedback; the selected or toggled state remains.
    </p>
  </section>
)

const SurfaceComparisons = () => (
  <section class="codex-section" id="surfaces">
    <div class="codex-section-heading">
      <div>
        <p class="codex-eyebrow">Pattern × surface</p>
        <h2>The same rules on four backgrounds</h2>
      </div>
      <p>
        Hover the row first, then its actions icon. Compare stable content, nested actions, standalone buttons and menu
        accessories in both libraries.
      </p>
    </div>
    <div class="icon-surface-grid">
      <For
        each={surfaces.filter(([, , token]) =>
          ["surface", "panel", "control-opaque", "elevated-primary"].includes(token),
        )}
      >
        {([label, color]) => (
          <article class="icon-surface-card" style={{ background: color }}>
            <h3>
              {label} <code>{color}</code>
            </h3>
            <For each={libraries}>
              {(library) => (
                <div class="icon-surface-library">
                  <span class="icon-library-label">{libraryLabel[library]}</span>
                  <div class="icon-stable-row">
                    <CompareGlyph library={library} name="folder" />
                    <span>Stable project icon</span>
                  </div>
                  <For each={["row-action", "create-terminal", "menu"]}>
                    {(id) => <PatternControl pattern={patterns.find((p) => p.id === id)!} library={library} live />}
                  </For>
                </div>
              )}
            </For>
          </article>
        )}
      </For>
    </div>
  </section>
)

const contextIcons = [
  ["Project", "folder"],
  ["Review changes", "changes"],
  ["Files", "folders"],
  ["Worktree", "worktree"],
  ["Processes", "process"],
  ["Create terminal", "terminal"],
] as const
const brands = ["claude", "openai", "cursor", "opencode", "pi"] as const
const ContextComparisons = () => (
  <section class="codex-section" id="contexts">
    <div class="codex-section-heading">
      <div>
        <p class="codex-eyebrow">Recognition & optical size</p>
        <h2>Environment, harnesses and display sizes</h2>
      </div>
      <p>
        Identical CSS boxes expose differences in optical weight. The previews use current mappings, with shared brand
        marks across themes.
      </p>
    </div>
    <div class="icon-comparison-columns">
      <For each={libraries}>
        {(library) => (
          <article class="icon-context-card">
            <h3>{libraryLabel[library]}</h3>
            <div class="icon-env-list">
              <For each={contextIcons}>
                {([label, name]) => (
                  <div class="icon-env-row">
                    <CompareGlyph library={library} name={name} />
                    <span>{label}</span>
                    <code>{name}</code>
                  </div>
                )}
              </For>
            </div>
            <div class="icon-brand-list">
              <For each={brands}>
                {(name) => (
                  <div>
                    <CompareGlyph library={library} name={name} />
                    <span>{name}</span>
                  </div>
                )}
              </For>
            </div>
            <div class="icon-env-list">
              <div class="icon-env-row">
                <ClaxedoIcon library={library} name="three-dots" />
                <span>Horizontal menu</span>
                <code>three-dots</code>
              </div>
              <div class="icon-env-row">
                <ClaxedoIcon library={library} name="three-dots" class="rotate-90" />
                <span>Vertical menu</span>
                <code>rotate-90</code>
              </div>
            </div>
            <div class="codex-size-list">
              <For each={sizes}>
                {([name, size]) => (
                  <div class="codex-size-item">
                    <span class="codex-size-stage">
                      <CompareGlyph library={library} name="folder" size={size} />
                    </span>
                    <code>{name}</code>
                    <span>{size}px</span>
                  </div>
                )}
              </For>
            </div>
          </article>
        )}
      </For>
    </div>
  </section>
)

const AsyncLifecycle = () => {
  const [phase, setPhase] = createSignal<"ready" | "pending" | "success" | "error">("ready")
  const [fail, setFail] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(timer))
  const activate = () => {
    if (phase() === "pending") return
    const shouldFail = fail()
    setPhase("pending")
    timer = setTimeout(() => setPhase(shouldFail ? "error" : "success"), 900)
  }
  return (
    <section class="codex-section" id="outcomes">
      <div class="codex-section-heading">
        <div>
          <p class="codex-eyebrow">Action lifecycle · interactive simulation</p>
          <h2>Pending, success, failure and retry</h2>
        </div>
        <p>Both previews share a simulated command result. No files or processes are changed.</p>
      </div>
      <div class="icon-outcome-options">
        <label>
          <input type="checkbox" checked={fail()} onChange={(event) => setFail(event.currentTarget.checked)} /> Make
          next attempt fail
        </label>
        <button
          type="button"
          onClick={() => {
            clearTimeout(timer)
            setPhase("ready")
          }}
        >
          Reset
        </button>
      </div>
      <div class="icon-comparison-columns">
        <For each={libraries}>
          {(library) => (
            <article class="icon-context-card">
              <h3>{libraryLabel[library]}</h3>
              <button
                class="icon-pattern-control"
                data-kind="text"
                type="button"
                data-phase={phase()}
                aria-busy={phase() === "pending"}
                aria-disabled={phase() === "pending"}
                onClick={activate}
              >
                <Show
                  when={phase() !== "pending"}
                  fallback={<span class="icon-reference-spinner" aria-hidden="true" />}
                >
                  <CompareGlyph library={library} name={phase() === "success" ? "check" : "copy"} />
                </Show>
                <span>
                  {{ ready: "Run example", pending: "Working…", success: "Run again", error: "Retry" }[phase()]}
                </span>
              </button>
              <p class="icon-outcome-status" role="status">
                {
                  {
                    ready: "Ready to run.",
                    pending: "Running. Duplicate activation is blocked.",
                    success: "Completed. Success is feedback, not selection.",
                    error: "Failed. State was not committed; retry is available.",
                  }[phase()]
                }
              </p>
            </article>
          )}
        </For>
      </div>
    </section>
  )
}

const UsageAudit = () => {
  const unresolved = appIconNames.filter((name) => iconMappingAudit[name]?.status === "fix")
  return (
    <section class="codex-section" id="usage">
      <div class="codex-section-heading">
        <div>
          <p class="codex-eyebrow">Unresolved artwork · source usage audit</p>
          <h2>Where these icons appear in Claxedo</h2>
        </div>
      </div>
      <p class="icon-reference-note">
        {unresolved.length} remaining {unresolved.length === 1 ? "icon needs" : "icons need"} correction, with confirmed
        direct or indirect callers. Checked Claxedo, shared session UI and shared UI; excluded catalogs, tests, stories,
        domain strings and HTML roles. Shared conversation components enter Claxedo through{" "}
        <code>ui/session-kit.ts</code>. These are source-confirmed paths, not a claim that every conditional screen is
        currently visible.
      </p>
      <div class="icon-usage-table-wrap">
        <table class="icon-usage-table">
          <thead>
            <tr>
              <th>Icon · Codex / OpenCode</th>
              <th>Needs correction</th>
              <th>How and where it is used</th>
              <th>Callers · expand to inspect source</th>
            </tr>
          </thead>
          <tbody>
            <For each={unresolved}>
              {(name) => (
                <tr data-usage-name={name}>
                  <td>
                    <code>{name}</code>
                    <div class="icon-usage-pair">
                      <CompareGlyph library="codex" name={name} />
                      <CompareGlyph library="opencode" name={name} />
                    </div>
                  </td>
                  <td>{iconMappingAudit[name]?.affected.join(", ")}</td>
                  <td>
                    <strong>
                      {iconMappingUsage[name]?.kind === "no-caller"
                        ? "No caller found"
                        : iconMappingUsage[name]?.kind === "indirect"
                          ? "Used through an alias"
                          : "Used in Claxedo"}
                    </strong>
                    <p>{iconMappingUsage[name]?.how}</p>
                  </td>
                  <td>
                    <For each={iconMappingUsage[name]?.references}>
                      {(ref) => (
                        <details>
                          <summary>
                            <code>
                              {ref.file.replace("packages/claxedo-app/src/", "claxedo/")}:{ref.line}
                            </code>
                          </summary>
                          <pre>{ref.context}</pre>
                        </details>
                      )}
                    </For>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </section>
  )
}

const MappingGallery = () => {
  const [query, setQuery] = createSignal("")
  const [verdict, setVerdict] = createSignal("all")
  const [previewSize, setPreviewSize] = createSignal(32)
  const filters = [
    ["all", "All pairs"],
    ["fix", "Needs correction"],
    ["decision", "Needs decision"],
    ["unflagged", "Not flagged"],
  ] as const
  const matchesVerdict = (name: AppIconName, filter: string) => {
    const status = iconMappingAudit[name]?.status
    if (filter === "all") return true
    if (filter === "unflagged") return status !== "fix" && status !== "decision"
    return status === filter
  }
  const names = createMemo(() =>
    appIconNames.filter((name) => {
      const audit = iconMappingAudit[name]
      return (
        matchesVerdict(name, verdict()) &&
        `${name} ${openCodeIconLibrary.resolve(name)} ${codexIconLibrary.resolve(name)} ${audit?.reason ?? ""} ${audit?.expected ?? ""}`
          .toLowerCase()
          .includes(query().trim().toLowerCase())
      )
    }),
  )
  return (
    <section class="codex-section" id="mappings">
      <div class="codex-section-heading">
        <div>
          <p class="codex-eyebrow">Complete app vocabulary</p>
          <h2>{appIconNames.length} names, two actual mappings</h2>
        </div>
        <label class="codex-search">
          <span class="codex-visually-hidden">Filter app icon mappings</span>
          <input
            type="search"
            placeholder="Find name or resolved glyph"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          <span>{names().length}</span>
        </label>
      </div>
      <p class="icon-reference-note">
        Visual audit · September 9, 2026. Red marks the side that needs correction; amber marks a remaining state
        decision. These are the current glyphs, with remaining review notes attached. “Codex” refers to our mapping of
        the extracted artwork.
      </p>
      <p class="icon-reference-note">
        The previews use the current production mappings. Codex includes native ChatGPT app artwork from build{" "}
        {nativeCodexManifest.appBuild}; OpenCode uses its own v1/v2 artwork and approved custom glyphs. Globe, cloud,
        gauge, reload, reset and worktree share Codex artwork across themes; Discord shares OpenCode’s brand mark. Process/terminal controls use Codex’s terminal or OpenCode’s bare {">"}_ console prompt. Other
        harness marks also share one source across themes.{" "}
        <a href="#usage">Review where every unresolved icon is used.</a>
      </p>
      <div class="icon-audit-toolbar">
        <div class="icon-audit-filters" role="group" aria-label="Filter by audit verdict">
          <For
            each={filters.filter(
              ([value]) => value === "all" || appIconNames.some((name) => matchesVerdict(name, value)),
            )}
          >
            {([value, label]) => (
              <button type="button" aria-pressed={verdict() === value} onClick={() => setVerdict(value)}>
                {label} <span>{appIconNames.filter((name) => matchesVerdict(name, value)).length}</span>
              </button>
            )}
          </For>
        </div>
        <label class="icon-audit-size">
          Icon size
          <select value={previewSize()} onChange={(event) => setPreviewSize(Number(event.currentTarget.value))}>
            <option value="20">20 px · actual</option>
            <option value="32">32 px · inspect</option>
            <option value="48">48 px · enlarged</option>
          </select>
        </label>
      </div>
      <p class="icon-audit-result" role="status">
        {names().length} pairs shown
      </p>
      <div class="icon-mapping-grid">
        <For each={names()}>
          {(name) => (
            <article
              class="icon-mapping-cell"
              data-mapping-name={name}
              data-audit={iconMappingAudit[name]?.status ?? "unflagged"}
            >
              <div class="icon-audit-heading">
                <h3>{name}</h3>
                <span class="icon-audit-badge">
                  {iconMappingAudit[name]?.status === "fix"
                    ? "Needs correction"
                    : iconMappingAudit[name]?.status === "decision"
                      ? "Needs decision"
                      : "Not flagged"}
                </span>
              </div>
              <div class="icon-mapping-pair">
                <For each={libraries}>
                  {(library) => (
                    <div data-flagged={iconMappingAudit[name]?.affected.includes(library) || undefined}>
                      <CompareGlyph library={library} name={name} size={previewSize()} />
                      <span>{library === "codex" ? "Codex" : "OpenCode"}</span>
                      <strong class="icon-audit-side">
                        {iconMappingAudit[name]?.affected.includes(library)
                          ? iconMappingAudit[name]?.status === "fix"
                            ? "Wrong mapping"
                            : "Review needed"
                          : "Not flagged"}
                      </strong>
                      <code>
                        {resolveIconArtworkLibrary(name, library) === "codex"
                          ? codexIconLibrary.resolve(name)
                          : openCodeIconLibrary.resolve(name)}
                      </code>
                      <Show when={iconMappingAudit[name]}>
                        {(audit) => <p class="icon-audit-observed">{audit().observed[library]}</p>}
                      </Show>
                    </div>
                  )}
                </For>
              </div>
              <Show when={iconMappingAudit[name]?.affected.length ? iconMappingAudit[name] : undefined}>
                {(audit) => (
                  <div class="icon-audit-notes">
                    <p>
                      <strong>Why flagged</strong>
                      {audit().reason}
                    </p>
                    <p>
                      <strong>{audit().status === "fix" ? "Needed" : "Decision"}</strong>
                      {audit().expected}
                    </p>
                  </div>
                )}
              </Show>
            </article>
          )}
        </For>
      </div>
      <Show when={names().length === 0}>
        <p class="icon-reference-note">No matching app icon.</p>
      </Show>
    </section>
  )
}

const OpenCodeGallery = () => {
  const [query, setQuery] = createSignal("")
  const artwork = [
    ...openCodeIconNames.map((name) => ({ ...getOpenCodeIconArtwork(name), version: "v1" })),
    ...openCodeV2IconNames.map((name) => ({ ...getOpenCodeV2IconArtwork(name), version: "v2" })),
  ]
  const names = createMemo(() => artwork.filter((icon) => icon.name.includes(query().trim().toLowerCase())))
  return (
    <section class="codex-section" id="opencode-inventory" data-inventory-count={artwork.length}>
      <div class="codex-section-heading">
        <div>
          <p class="codex-eyebrow">Complete OpenCode UI inventory · live source</p>
          <h2>{artwork.length} renderer glyphs · v1 + v2</h2>
        </div>
        <label class="codex-search">
          <span class="codex-visually-hidden">Filter OpenCode icons</span>
          <input
            type="search"
            placeholder="Filter native icon name"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          <span>{names().length}</span>
        </label>
      </div>
      <p class="icon-reference-note">
        Every key from both renderer artwork tables, including upstream glyphs and existing local helpers without an app
        alias. Exports always include the full set, regardless of this filter. Original viewBoxes and paths are
        preserved.
      </p>
      <div class="icon-export-actions">
        <a href={openCodeSprite} download="opencode-sprite.svg">
          Download OpenCode SVG sprite
        </a>
        <a href={openCodeManifest} download="opencode-manifest.json">
          Download OpenCode manifest
        </a>
        <a href={openCodeV2Sprite} download="opencode-v2-sprite.svg">
          Download OpenCode v2 SVG sprite
        </a>
        <a href={openCodeV2Manifest} download="opencode-v2-manifest.json">
          Download OpenCode v2 manifest
        </a>
      </div>
      <div class="icon-native-grid">
        <For each={names()}>
          {(icon) => (
            <div class="codex-icon-cell" data-native-icon={icon.id}>
              <svg
                width="20"
                height="20"
                viewBox={icon.viewBox}
                fill="none"
                aria-hidden="true"
                innerHTML={icon.content}
              />
              <code>{icon.name}</code>
              <span>{icon.version}</span>
            </div>
          )}
        </For>
      </div>
      <Show when={names().length === 0}>
        <p class="icon-reference-note">No matching native icon.</p>
      </Show>
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
            icon.id.includes(value) || icon.hash.includes(value) || icon.sourceSymbol?.toLowerCase().includes(value)
          )
        }),
      }))
      .filter((group) => group.icons.length > 0)
  })
  const visibleCount = createMemo(() => visibleGroups().reduce((total, group) => total + group.icons.length, 0))

  return (
    <section class="codex-section" id="codex-inventory" aria-labelledby="gallery-heading">
      <div class="codex-section-heading codex-gallery-heading">
        <div>
          <p class="codex-eyebrow">Extracted inventory</p>
          <h2 id="gallery-heading">{manifest.icons.length} extracted Codex components</h2>
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

const Reference = () => {
  // The Codex column uses the app renderer; the OpenCode column is explicitly native.
  // Restore the process-local preference when leaving this story.
  const preference = iconLibraryPreference()
  onMount(() => setIconLibraryPreference("codex"))
  onCleanup(() => setIconLibraryPreference(preference))
  return (
    <main class="codex-reference">
      <header class="codex-hero">
        <div>
          <p class="codex-eyebrow">Codex × OpenCode · icon system reference</p>
          <h1>
            One interaction language.
            <br />
            Both icon libraries.
          </h1>
          <p>
            Compare every app icon, inspect the complete native inventories, and exercise each interaction pattern side
            by side.
          </p>
        </div>
        <div class="codex-hero-mark">
          <CompareGlyph library="codex" name="folder" size={28} />
          <CompareGlyph library="opencode" name="folder" size={28} />
          <span>
            Same box.
            <br />
            Actual artwork.
          </span>
        </div>
      </header>
      <nav class="icon-reference-nav" aria-label="Reference sections">
        <For
          each={[
            ["patterns", "State lifecycle"],
            ["surfaces", "Surfaces"],
            ["contexts", "Context & sizes"],
            ["outcomes", "Outcomes"],
            ["mappings", "App mappings"],
            ["usage", "Unresolved usage"],
            ["opencode-inventory", "OpenCode inventory"],
            ["codex-inventory", "Codex inventory"],
          ]}
        >
          {([id, label]) => <a href={`#${id}`}>{label}</a>}
        </For>
      </nav>
      <p class="icon-reference-intro">
        Artwork and aliases come from the current renderers. Interaction examples demonstrate the proposed shared
        contract; they are not a claim that every production control already follows it. Other themes use the OpenCode
        library with the explicit shared-artwork choices listed below. Both columns use the same reference surfaces to
        isolate icon differences.
      </p>
      <Lifecycle />
      <SurfaceComparisons />
      <ContextComparisons />
      <AsyncLifecycle />
      <MappingGallery />
      <UsageAudit />
      <OpenCodeGallery />
      <Tokens />
      <Gallery />
    </main>
  )
}

export default {
  title: "Reference/Codex Icon System",
  id: "reference-codex-icon-system",
  parameters: {
    layout: "fullscreen",
    themes: { themeOverride: "dark" },
    docs: {
      description: {
        component:
          "Codex and OpenCode inventories, current app mappings, and a side-by-side interaction lifecycle reference. Codex source extraction: desktop build 5848. OpenCode inventory: current renderer.",
      },
    },
  },
}
export const CompleteReference = { render: () => <Reference /> }
