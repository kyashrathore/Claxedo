import { For, Match, Show, Switch, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import {
  toolNameAliases,
  type AgentContentPart,
  type AgentPresentationMessage,
} from "@claxedo/agent-runtime-contract"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import {
  composeTranscriptTypography,
  normalizeTranscriptTypography,
  resolveTranscriptTypography,
  transcriptTypographyStyle,
  type TranscriptTypography,
} from "@opencode-ai/ui/theme/transcript-typography"
import { DataProvider } from "../context/data"
import { renderable } from "./message-part"
import {
  CONTEXT_GROUP_TOOLS,
  HIDDEN_TOOLS,
  STANDALONE_TOOLS,
  groupParts,
  isSubagentToolPart,
  type GroupablePart,
  type PartRef,
} from "./part-groups"
import { assistantMessageSettled, countFoldableGroups, foldedGroupKeys, turnFoldDecision } from "./turn-fold"
import { SessionTurn } from "./story-session-turn"
import { TranscriptTypographyKnobs } from "./transcript-typography-knobs"
import { FileStub } from "./story-stubs"
import type { SubagentView } from "../context/data"
import { TRANSCRIPT_LAB_SESSIONS, type TranscriptLabSession } from "./transcript-lab-fixture"

type LabState = {
  session: string
  turnSeparator: "none" | "hairline" | "numbered"
  mutedLift: number
  machinery: "shipped" | "thinking" | "expanded" | "prose"
  rowGap: number
  proseLeadIn: number
  turnFold: "off" | "machinery"
  liveTurn: "settled" | "running"
  toolOutput: "shipped" | "boxed" | "scrollbar"
  errorCard: "shipped" | "hairline" | "quiet"
}

/**
 * Every value here is what the shipped Claxedo app renders today, so the lab opens at
 * parity and each control is a deliberate departure. `machinery: "shipped"` encodes
 * settings default `showReasoningSummaries: false`
 * (claxedo-app/src/platform/settings/provider.tsx:116). Typography is not a lever:
 * the app's own dev-only knobs render beside these, over an empty
 * `TranscriptTypography` — the theme's pairing, as a fresh install renders.
 */
const SHIPPED: LabState = {
  session: TRANSCRIPT_LAB_SESSIONS[0]?.id ?? "",
  turnSeparator: "none",
  mutedLift: 0,
  machinery: "shipped",
  rowGap: 12,
  proseLeadIn: 24,
  turnFold: "machinery",
  liveTurn: "settled",
  toolOutput: "shipped",
  errorCard: "shipped",
}


type Muted = { weak: string; weaker: string }

type Control =
  | { kind: "segment"; options: { value: string; label: string }[] }
  | { kind: "range"; min: number; max: number; step: number; unit: string }

type Lever = {
  key: keyof LabState
  group: string
  label: string
  finding: string
  origin: string
  control: Control
  css: (state: LabState, muted: Muted | undefined) => string
}

const SCOPE = "#tl-stage"

/** The app's own transcript geometry: message-timeline.tsx:1415-1420 plus its `px-5` rows. */
const BASE_CSS = [
  `${SCOPE} .tl-column{width:100%;max-width:var(--transcript-measure,48rem);margin-inline:auto;padding-inline:20px;`,
  `padding-block:28px 64px;display:flex;flex-direction:column}`,
  `@media (min-width:1536px){${SCOPE} .tl-column{max-width:var(--transcript-measure,880px)}}`,
].join("")

/**
 * The app sets these declarations inline on its timeline root; the lab writes them as a
 * rule. No theme here, so an empty setting composes to the shipped `default` pairing.
 */
function typographyCss(typography: TranscriptTypography) {
  const resolved = resolveTranscriptTypography(composeTranscriptTypography(typography, undefined))
  const declarations = Object.entries(transcriptTypographyStyle(resolved))
    .map(([property, value]) => `${property}:${value}`)
    .join(";")
  return `${SCOPE}{${declarations}}`
}

const LEVERS: Lever[] = [
  {
    key: "turnSeparator",
    group: "Hierarchy",
    label: "Turn boundary",
    finding: "Turns are separated by a bare 24px spacer div and nothing else.",
    origin: "message-timeline.tsx:1447",
    control: {
      kind: "segment",
      options: [
        { value: "none", label: "gap only" },
        { value: "hairline", label: "hairline" },
        { value: "numbered", label: "numbered" },
      ],
    },
    css: (s) => {
      if (s.turnSeparator === "none") return ""
      const line = `${SCOPE} .tl-turn + .tl-turn{border-top:0.5px solid var(--border-weak-base);padding-top:24px}`
      if (s.turnSeparator === "hairline") return line
      return [
        `${SCOPE} .tl-column{counter-reset:tl-turn}`,
        `${SCOPE} .tl-turn{counter-increment:tl-turn;position:relative}`,
        line,
        `${SCOPE} .tl-turn + .tl-turn::before{content:counter(tl-turn);position:absolute;top:14px;left:-28px;` +
          `font:500 10px/1 var(--font-family-mono);color:var(--text-weaker);font-variant-numeric:tabular-nums}`,
      ].join("\n")
    },
  },
  {
    key: "mutedLift",
    group: "Contrast",
    label: "Muted text lift",
    finding: "Tool rows, group headers and the thinking line all use --text-weak. AA for 14px is 4.5:1.",
    origin: "ui/src/styles/theme.css:281, overridden per theme",
    control: { kind: "range", min: 0, max: 100, step: 5, unit: "%" },
    css: (_s, muted) => (muted ? `${SCOPE}{--text-weak:${muted.weak};--text-weaker:${muted.weaker}}` : ""),
  },
  {
    key: "rowGap",
    group: "Density",
    label: "Row gap",
    finding: "12px between every part row, including one-line 32px folded group rows.",
    origin: "session-turn.css:88 and message-part.css:7",
    control: { kind: "range", min: 0, max: 20, step: 1, unit: "px" },
    css: (s) =>
      s.rowGap === SHIPPED.rowGap
        ? ""
        : `${SCOPE} [data-slot="session-turn-assistant-content"],${SCOPE} [data-component="assistant-message"]` +
          `{gap:${s.rowGap}px}`,
  },
  {
    key: "proseLeadIn",
    group: "Density",
    label: "Prose lead-in",
    finding: "A text part adds 24px of its own on top of the row gap, so prose sits 36px below the work above it.",
    origin: "message-part.css:244",
    control: { kind: "range", min: 0, max: 32, step: 1, unit: "px" },
    css: (s) => (s.proseLeadIn === SHIPPED.proseLeadIn ? "" : `${SCOPE} .ui-text-part{margin-top:${s.proseLeadIn}px}`),
  },
  {
    key: "turnFold",
    group: "Density",
    label: "Turn fold",
    finding: "Only tool rows count as machinery, so narration text and reasoning stay visible under the fold.",
    origin: "turn-fold.ts isFoldableGroup",
    control: {
      kind: "segment",
      options: [
        { value: "off", label: "no fold" },
        { value: "tools", label: "tools only" },
      ],
    },
    css: () => "",
  },
  {
    key: "liveTurn",
    group: "Density",
    label: "Last turn",
    finding:
      "Folding a running turn is on by default and keeps the live group visible; Settings \u2192 General turns it off.",
    origin: "settings general.timelineFoldWhileRunning",
    control: {
      kind: "segment",
      options: [
        { value: "settled", label: "settled" },
        { value: "running", label: "running" },
      ],
    },
    css: () => "",
  },
  {
    key: "toolOutput",
    group: "Density",
    label: "Tool output",
    finding: "Output is capped at 240px and scrolls, but the scrollbar is hidden and nothing frames the text.",
    origin: "message-part.css:359-400",
    control: {
      kind: "segment",
      options: [
        { value: "shipped", label: "bare" },
        { value: "boxed", label: "boxed" },
        { value: "scrollbar", label: "boxed + bar" },
      ],
    },
    css: (s) => {
      if (s.toolOutput === "shipped") return ""
      const target = `${SCOPE} [data-component="tool-output"]`
      const box =
        `${target}{background:var(--surface-inset-base);border:0.5px solid var(--border-weak-base);` +
        `border-radius:var(--radius-md);padding:8px 10px}`
      if (s.toolOutput === "boxed") return box
      return `${box}
${target}[data-scrollable]{scrollbar-width:thin;scrollbar-color:var(--border-weak-base) transparent}`
    },
  },
  {
    key: "errorCard",
    group: "Density",
    label: "Error card",
    finding: "A 1px border and a saturated accent icon against a transcript drawn in 0.5px hairlines.",
    origin: "tool-error-card.css:1-32",
    control: {
      kind: "segment",
      options: [
        { value: "shipped", label: "as shipped" },
        { value: "hairline", label: "hairline" },
        { value: "quiet", label: "quiet" },
      ],
    },
    css: (s) => {
      if (s.errorCard === "shipped") return ""
      const card = `${SCOPE} .ui-card[data-kind="tool-error-card"]`
      const hairline = `${card}{border-width:0.5px}`
      if (s.errorCard === "hairline") return hairline
      return `${hairline}
${card}{border-color:var(--border-weaker-base);background:transparent}
` +
        `${card} [data-component="tool-error-card-icon"] .ui-icon{color:var(--text-weak)}`
    },
  },
  {
    key: "machinery",
    group: "Density",
    label: "Machinery",
    finding: "Tool calls are 52% of rendered blocks and prose is 10.5%; prose is 1.4% of bytes.",
    origin: "measured over the 12 most recent logs for this project",
    control: {
      kind: "segment",
      options: [
        { value: "shipped", label: "as shipped" },
        { value: "thinking", label: "+ thinking" },
        { value: "expanded", label: "tools open" },
        { value: "prose", label: "prose only" },
      ],
    },
    css: () => "",
  },
]

const GROUPS = [...new Set(LEVERS.map((lever) => lever.group))]

function luminance(rgb: [number, number, number]) {
  const channel = (value: number) => {
    const v = value / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
}

function contrast(a: [number, number, number], b: [number, number, number]) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** `getComputedStyle` always returns rgb()/rgba(), so a numeric parse is sufficient here. */
function parseRgb(value: string): [number, number, number] | undefined {
  const parts = value.match(/-?[\d.]+/g)
  if (!parts || parts.length < 3) return undefined
  const [r, g, b] = parts.map(Number)
  if (r === undefined || g === undefined || b === undefined) return undefined
  return [r, g, b]
}

function composite(
  fg: [number, number, number],
  alpha: number,
  bg: [number, number, number],
): [number, number, number] {
  const over = (channel: number, under: number) => Math.round(alpha * channel + (1 - alpha) * under)
  return [over(fg[0], bg[0]), over(fg[1], bg[1]), over(fg[2], bg[2])]
}

function blendToward(
  from: [number, number, number],
  to: [number, number, number],
  amount: number,
): [number, number, number] {
  const step = (start: number, end: number) => Math.round(start + (end - start) * amount)
  return [step(from[0], to[0]), step(from[1], to[1]), step(from[2], to[2])]
}

type Probe = {
  bg: [number, number, number]
  weak: [number, number, number]
  weaker: [number, number, number]
  strong: [number, number, number]
}

function readProbe(): Probe | undefined {
  const host = document.createElement("div")
  host.style.cssText = "position:fixed;left:-9999px;top:0;pointer-events:none"
  for (const [name, property, value] of [
    ["bg", "background-color", "var(--background-stronger)"],
    ["weak", "color", "var(--text-weak)"],
    ["weaker", "color", "var(--text-weaker)"],
    ["strong", "color", "var(--text-strong)"],
  ] as const) {
    const node = document.createElement("i")
    node.dataset.p = name
    node.style.setProperty(property, value)
    host.append(node)
  }
  document.body.append(host)
  const read = (name: string, prop: "color" | "backgroundColor") => {
    const node = host.querySelector(`[data-p="${name}"]`)
    if (!node) return undefined
    const style = getComputedStyle(node)
    const parsed = parseRgb(style[prop])
    if (!parsed) return undefined
    const alpha = Number(style[prop].match(/-?[\d.]+/g)?.[3] ?? 1)
    return { rgb: parsed, alpha }
  }
  const bg = read("bg", "backgroundColor")
  const weak = read("weak", "color")
  const weaker = read("weaker", "color")
  const strong = read("strong", "color")
  host.remove()
  if (!bg || !weak || !weaker || !strong) return undefined
  const base = composite(bg.rgb, bg.alpha, [255, 255, 255])
  return {
    bg: base,
    weak: composite(weak.rgb, weak.alpha, base),
    weaker: composite(weaker.rgb, weaker.alpha, base),
    strong: composite(strong.rgb, strong.alpha, base),
  }
}

const rgbCss = (rgb: [number, number, number]) => `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]})`

const PANEL_BG = "#131313"
const PANEL_LINE = "rgba(255,255,255,0.09)"
const PANEL_TEXT = "rgba(255,255,255,0.62)"
const PANEL_DIM = "rgba(255,255,255,0.34)"
const SIGNAL = "#e0a94a"

function Segmented(props: {
  options: { value: string; label: string }[]
  value: string
  dirty: boolean
  onSelect: (value: string) => void
}) {
  return (
    <div style={{ display: "flex", "flex-wrap": "wrap", gap: "1px", background: PANEL_LINE, padding: "1px" }}>
      <For each={props.options}>
        {(option) => {
          const on = () => option.value === props.value
          return (
            <button
              type="button"
              onClick={() => props.onSelect(option.value)}
              style={{
                flex: "1 1 auto",
                padding: "5px 7px",
                border: "none",
                cursor: "pointer",
                "font-family": "var(--font-family-mono)",
                "font-size": "10px",
                "letter-spacing": "0.02em",
                background: on() ? (props.dirty ? SIGNAL : "rgba(255,255,255,0.13)") : PANEL_BG,
                color: on() ? (props.dirty ? "#181203" : "#f0f0f0") : PANEL_DIM,
              }}
            >
              {option.label}
            </button>
          )
        }}
      </For>
    </div>
  )
}

function Range(props: {
  control: Extract<Control, { kind: "range" }>
  value: number
  dirty: boolean
  onInput: (value: number) => void
}) {
  return (
    <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
      <input
        type="range"
        min={props.control.min}
        max={props.control.max}
        step={props.control.step}
        value={props.value}
        onInput={(event) => props.onInput(Number(event.currentTarget.value))}
        style={{ flex: "1", "accent-color": props.dirty ? SIGNAL : "#8a8a8a", height: "14px" }}
      />
      <span
        style={{
          "font-family": "var(--font-family-mono)",
          "font-size": "10px",
          "font-variant-numeric": "tabular-nums",
          "min-width": "42px",
          "text-align": "right",
          color: props.dirty ? SIGNAL : PANEL_DIM,
        }}
      >
        {props.value}
        {props.control.unit}
      </span>
    </div>
  )
}

function Census(props: { label: string; value: number; note?: string }) {
  return (
    <div style={{ display: "flex", "align-items": "baseline", gap: "8px" }}>
      <span style={{ color: props.value ? SIGNAL : "rgba(255,255,255,0.24)", "min-width": "26px" }}>
        {props.value}
      </span>
      <span style={{ flex: "1" }}>{props.label}</span>
      <Show when={props.note}>
        <span style={{ color: "rgba(255,255,255,0.26)", "font-size": "9px" }}>{props.note}</span>
      </Show>
    </div>
  )
}

const SPAWN_TOOL_NAMES = [
  "task",
  ...toolNameAliases().filter(([, target]) => target === "task").map(([alias]) => alias),
]

function FoldRule(props: { title: string; tools: string[] }) {
  return (
    <div style={{ "margin-bottom": "6px" }}>
      <div style={{ color: "rgba(255,255,255,0.45)" }}>{props.title}</div>
      <div style={{ "word-break": "break-word" }}>{props.tools.join("  ")}</div>
    </div>
  )
}

function TranscriptLab() {
  const [state, setState] = createStore<LabState>({ ...SHIPPED })

  /* Every LabState field holds a string or a number, so this call typechecks for any
     lever; only the control's own option list keeps the value in its key's range. */
  const setLever = (lever: Lever, value: string | number) => setState(lever.key, value)
  const [typography, setTypography] = createSignal<TranscriptTypography>({})
  const [holding, setHolding] = createSignal(false)
  const [showDiff, setShowDiff] = createSignal(false)
  const [themeTick, setThemeTick] = createSignal(0)

  const effective = createMemo<LabState>(() =>
    holding() ? { ...SHIPPED, session: state.session } : { ...state },
  )
  const effectiveTypography = createMemo<TranscriptTypography>(() => (holding() ? {} : typography()))
  const typographyChanges = createMemo(() =>
    Object.entries(effectiveTypography()).flatMap(([key, value]) => (value === undefined ? [] : [`${key}: ${String(value)}`])),
  )

  const session = createMemo<TranscriptLabSession | undefined>(
    () => TRANSCRIPT_LAB_SESSIONS.find((entry) => entry.id === effective().session) ?? TRANSCRIPT_LAB_SESSIONS[0],
  )

  onMount(() => {
    const root = document.documentElement
    const bump = () => setThemeTick((tick) => tick + 1)
    const observer = new MutationObserver(bump)
    observer.observe(root, { attributes: true, attributeFilter: ["class", "style", "data-theme"] })
    observer.observe(document.body, { attributes: true, attributeFilter: ["class", "style"] })
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    media.addEventListener("change", bump)
    onCleanup(() => {
      observer.disconnect()
      media.removeEventListener("change", bump)
    })
  })

  /* The preview decorator mirrors an app.tsx body class that no longer exists and sets
     `data-new-layout`, which the app never does, so the lab strips both to render at true
     app parity and restores them for the rest of Storybook. */
  onMount(() => {
    const stripped = ["font-(family-name:--font-family-text)", "text-[13px]", "font-[440]"].filter((name) =>
      document.body.classList.contains(name),
    )
    for (const name of stripped) document.body.classList.remove(name)
    document.body.toggleAttribute("data-new-layout", false)
    onCleanup(() => {
      for (const name of stripped) document.body.classList.add(name)
      document.body.toggleAttribute("data-new-layout", true)
    })
  })

  const probe = createMemo(() => {
    themeTick()
    return readProbe()
  })

  const muted = createMemo<Muted | undefined>(() => {
    const lift = effective().mutedLift / 100
    const values = probe()
    if (!values || lift === 0) return undefined
    return {
      weak: rgbCss(blendToward(values.weak, values.strong, lift)),
      weaker: rgbCss(blendToward(values.weaker, values.strong, lift)),
    }
  })

  const weakRatio = createMemo(() => {
    const values = probe()
    if (!values) return undefined
    const lift = effective().mutedLift / 100
    return contrast(blendToward(values.weak, values.strong, lift), values.bg)
  })

  const overrides = createMemo(() =>
    [typographyCss(effectiveTypography()), ...LEVERS.map((lever) => lever.css(effective(), muted()))]
      .filter(Boolean)
      .join("\n"),
  )

  const css = createMemo(() => `${BASE_CSS}\n${overrides()}`)

  const changed = createMemo(() =>
    LEVERS.filter((lever) => effective()[lever.key] !== SHIPPED[lever.key]),
  )
  const changeCount = createMemo(() => changed().length + typographyChanges().length)

  const lastUserID = createMemo(() => {
    const list = session()?.messages ?? []
    return [...list].reverse().find((message) => message.role === "user")?.id
  })

  const messages = createMemo<AgentPresentationMessage[]>(() => {
    const list = session()?.messages ?? []
    if (effective().liveTurn !== "running") return list
    const parent = lastUserID()
    return list.map((message) =>
      message.role === "assistant" && message.parentID === parent
        ? { ...message, time: { created: message.time.created } }
        : message,
    )
  })

  const parts = createMemo<Record<string, AgentContentPart[]>>(() => {
    const source = session()?.parts ?? {}
    const mode = effective().machinery
    if (mode !== "prose") return source
    const filtered: Record<string, AgentContentPart[]> = {}
    for (const [id, list] of Object.entries(source)) {
      filtered[id] = list.filter((part) => part.type !== "tool" && part.type !== "reasoning")
    }
    return filtered
  })

  const userMessages = createMemo(() => messages().filter((message) => message.role === "user"))

  const subagents = createMemo(() => {
    const index = new Map<string, { agentLabel: string; description: string; childSessionId?: string }>()
    for (const list of Object.values(session()?.parts ?? {})) {
      for (const part of list) {
        if (part.type !== "tool" || !isSubagentToolPart(part)) continue
        const input = part.state.input as { subagent_type?: unknown; description?: unknown }
        const metadata = "metadata" in part.state ? part.state.metadata : undefined
        const sessionId = metadata?.["sessionId"]
        index.set(part.callID, {
          agentLabel: typeof input.subagent_type === "string" ? input.subagent_type : part.tool,
          description: typeof input.description === "string" ? input.description : part.tool,
          childSessionId: typeof sessionId === "string" ? sessionId : undefined,
        })
      }
    }
    return index
  })

  const resolveSubagents = (parentSessionId: string, toolCallId?: string): SubagentView[] => {
    if (!toolCallId) return []
    const entry = subagents().get(toolCallId)
    if (!entry) return []
    return [
      {
        parentSessionId,
        subagentKey: toolCallId,
        toolCallRole: "spawn",
        mode: "foreground",
        status: "completed",
        label: entry.agentLabel,
        agentLabel: entry.agentLabel,
        description: entry.description,
        childSessionId: entry.childSessionId,
        transcriptKind: "none",
        resolution: "ready",
        ambient: false,
      },
    ]
  }

  const data = createMemo(() => {
    const current = session()
    return {
      session: [
        {
          id: current?.sessionID ?? "lab",
          projectID: "transcript-lab",
          directory: "/Users/yashvardhansingh/test/opencode",
          title: current?.title ?? "Transcript lab",
          time: { created: 0, updated: 0 },
        },
      ],
      session_status: {},
      session_diff: {},
      message: { [current?.sessionID ?? "lab"]: messages() },
      part: parts(),
    }
  })

  const fold = createMemo(() => {
    const current = session()
    if (!current) return undefined
    const show = effective().machinery === "thinking"
    const tally = { work: 0, context: 0, agents: 0, standalone: 0, members: 0, hidden: 0, subagents: 0, folded: 0 }
    for (const user of current.messages) {
      if (user.role !== "user") continue
      const items: GroupablePart[] = []
      const partByID = new Map<string, AgentContentPart>()
      let settled = false
      for (const message of current.messages) {
        if (message.role !== "assistant" || message.parentID !== user.id) continue
        settled ||= assistantMessageSettled(message)
        for (const part of parts()[message.id] ?? []) {
          if (part.type === "tool" && HIDDEN_TOOLS.has(part.tool)) tally.hidden += 1
          if (isSubagentToolPart(part)) tally.subagents += 1
          if (!renderable(part, show)) continue
          partByID.set(part.id, part)
          items.push({ messageID: message.id, part })
        }
      }
      const groups = groupParts(items)
      for (const group of groups) {
        if (group.type === "part") tally.standalone += 1
        else {
          tally[group.type] += 1
          tally.members += group.refs.length
        }
      }
      const partOf = (ref: PartRef) => partByID.get(ref.partID)
      const decision = turnFoldDecision({ settled, foldableCount: countFoldableGroups(groups, partOf) })
      tally.folded += foldedGroupKeys(decision, groups, partOf).size
    }
    return tally
  })


  const stats = createMemo(() => {
    const current = session()?.stats
    if (!current) return undefined
    const blocks = current.textParts + current.reasoningParts + current.toolParts
    const bytes = current.proseChars + current.machineryChars
    return {
      blocks,
      prosePct: blocks ? (100 * current.textParts) / blocks : 0,
      toolPct: blocks ? (100 * current.toolParts) / blocks : 0,
      byteProsePct: bytes ? (100 * current.proseChars) / bytes : 0,
      turns: current.userTurns,
    }
  })

  const groupLabel = {
    "font-family": "var(--font-family-mono)",
    "font-size": "9px",
    "letter-spacing": "0.14em",
    "text-transform": "uppercase",
    color: "rgba(255,255,255,0.28)",
  } as const

  return (
    <div
      style={{
        position: "fixed",
        inset: "0",
        display: "flex",
        "min-height": "0",
        background: "var(--background-stronger)",
      }}
    >
      <style>{css()}</style>

      <aside
        style={{
          width: "296px",
          "flex-shrink": "0",
          display: "flex",
          "flex-direction": "column",
          background: PANEL_BG,
          "border-right": `0.5px solid ${PANEL_LINE}`,
          color: PANEL_TEXT,
        }}
      >
        <header style={{ padding: "14px 14px 12px", "border-bottom": `0.5px solid ${PANEL_LINE}` }}>
          <div style={{ ...groupLabel, color: SIGNAL }}>Transcript lab</div>
          <div
            style={{
              "font-family": "var(--font-family-mono)",
              "font-size": "10px",
              "line-height": "1.5",
              color: PANEL_DIM,
              "margin-top": "6px",
            }}
          >
            Defaults render the shipped app exactly. Every amber control is a departure.
          </div>
        </header>

        <div style={{ padding: "12px 14px", "border-bottom": `0.5px solid ${PANEL_LINE}` }}>
          <div style={{ ...groupLabel, "margin-bottom": "6px" }}>Session</div>
          <Segmented
            options={TRANSCRIPT_LAB_SESSIONS.map((entry) => ({ value: entry.id, label: entry.title }))}
            value={effective().session}
            dirty={false}
            onSelect={(value) => setState("session", value)}
          />
          <Show when={stats()}>
            {(value) => (
              <div
                style={{
                  "margin-top": "9px",
                  "font-family": "var(--font-family-mono)",
                  "font-size": "10px",
                  "font-variant-numeric": "tabular-nums",
                  "line-height": "1.7",
                  color: PANEL_DIM,
                }}
              >
                <div>
                  {value().turns} turns · {value().blocks} blocks
                </div>
                <div>
                  prose {value().prosePct.toFixed(1)}% of blocks · {value().byteProsePct.toFixed(1)}% of bytes
                </div>
                <div>tools {value().toolPct.toFixed(1)}% of blocks</div>
              </div>
            )}
          </Show>
        </div>

        <div style={{ flex: "1", "overflow-y": "auto", padding: "4px 14px 14px" }}>
          <section style={{ "margin-top": "16px" }}>
            <div style={{ ...groupLabel, "margin-bottom": "6px", color: typographyChanges().length ? SIGNAL : undefined }}>
              Typography · the app's dev panel
            </div>
            {/* The panel's rows read the theme's text tokens; the lab's aside is always dark. */}
            <div
              style={{
                margin: "0 -6px",
                "--color-text-base": "rgba(255,255,255,0.72)",
                "--color-text-strong": "rgba(255,255,255,0.92)",
                "--color-text-weak": PANEL_DIM,
                "--color-surface-base-hover": "rgba(255,255,255,0.08)",
              }}
            >
              <TranscriptTypographyKnobs
                value={effectiveTypography()}
                pairingDetail="Theme · Default"
                onPairing={(pairing) => setTypography(pairing ? { pairing } : {})}
                onOverride={(patch) => setTypography((current) => normalizeTranscriptTypography({ ...current, ...patch }))}
              />
            </div>
          </section>
          <For each={GROUPS}>
            {(group) => (
              <section style={{ "margin-top": "16px" }}>
                <div style={{ ...groupLabel, "margin-bottom": "9px" }}>{group}</div>
                <For each={LEVERS.filter((lever) => lever.group === group)}>
                  {(lever) => {
                    const dirty = () => effective()[lever.key] !== SHIPPED[lever.key]
                    return (
                      <div style={{ "margin-bottom": "13px" }}>
                        <div
                          style={{
                            display: "flex",
                            "align-items": "baseline",
                            "justify-content": "space-between",
                            gap: "8px",
                            "margin-bottom": "5px",
                          }}
                        >
                          <span
                            style={{
                              "font-family": "var(--font-family-mono)",
                              "font-size": "10.5px",
                              color: dirty() ? SIGNAL : "rgba(255,255,255,0.72)",
                            }}
                          >
                            {lever.label}
                          </span>
                          <Show when={dirty()}>
                            <span
                              style={{
                                "font-family": "var(--font-family-mono)",
                                "font-size": "9px",
                                color: PANEL_DIM,
                              }}
                              title={`shipped: ${String(SHIPPED[lever.key])}`}
                            >
                              was {String(SHIPPED[lever.key])}
                            </span>
                          </Show>
                        </div>
                        <Switch>
                          <Match when={lever.control.kind === "segment" ? lever.control : undefined}>
                            {(control) => (
                              <Segmented
                                options={control().options}
                                value={String(effective()[lever.key])}
                                dirty={dirty()}
                                onSelect={(value) => setLever(lever, value)}
                              />
                            )}
                          </Match>
                          <Match when={lever.control.kind === "range" ? lever.control : undefined}>
                            {(control) => (
                              <Range
                                control={control()}
                                value={Number(effective()[lever.key])}
                                dirty={dirty()}
                                onInput={(value) => setLever(lever, value)}
                              />
                            )}
                          </Match>
                        </Switch>
                        <Show when={lever.key === "mutedLift" && weakRatio()}>
                          {(ratio) => (
                            <div
                              style={{
                                display: "flex",
                                "align-items": "center",
                                gap: "6px",
                                "margin-top": "6px",
                                "font-family": "var(--font-family-mono)",
                                "font-size": "9.5px",
                                "font-variant-numeric": "tabular-nums",
                              }}
                            >
                              <span
                                style={{
                                  width: "6px",
                                  height: "6px",
                                  "border-radius": "999px",
                                  background: ratio() >= 4.5 ? "#5fbf6a" : "#d4573f",
                                }}
                              />
                              <span style={{ color: ratio() >= 4.5 ? "#8fce96" : "#e08670" }}>
                                --text-weak {ratio().toFixed(2)}:1
                              </span>
                              <span style={{ color: "rgba(255,255,255,0.24)" }}>AA needs 4.50</span>
                            </div>
                          )}
                        </Show>
                        <div
                          style={{
                            "margin-top": "5px",
                            "font-size": "9.5px",
                            "line-height": "1.5",
                            color: "rgba(255,255,255,0.26)",
                          }}
                        >
                          {lever.finding}
                        </div>
                      </div>
                    )
                  }}
                </For>
              </section>
            )}
          </For>

          <section style={{ "margin-top": "20px" }}>
            <div style={{ ...groupLabel, "margin-bottom": "9px" }}>Folding</div>
            <Show when={fold()}>
              {(tally) => (
                <div
                  style={{
                    "font-family": "var(--font-family-mono)",
                    "font-size": "10px",
                    "font-variant-numeric": "tabular-nums",
                    "line-height": "1.8",
                    color: PANEL_TEXT,
                  }}
                >
                  <Census label="work groups" value={tally().work} note={`${tally().members} rows grouped`} />
                  <Census label="context groups" value={tally().context} />
                  <Census label="agent rows" value={tally().agents} note={`${tally().subagents} subagent calls`} />
                  <Census label="standalone rows" value={tally().standalone} />
                  <Census label="hidden parts" value={tally().hidden} note="never rendered" />
                  <Census label="groups folded" value={tally().folded} note="hidden behind the fold" />
                </div>
              )}
            </Show>
            <div
              style={{
                "margin-top": "10px",
                "font-family": "var(--font-family-mono)",
                "font-size": "9px",
                "line-height": "1.6",
                color: "rgba(255,255,255,0.3)",
              }}
            >
              <FoldRule
                title="context group · any run length"
                tools={[...CONTEXT_GROUP_TOOLS]}
              />
              <FoldRule title="work group · runs of 2+" tools={["everything not named below"]} />
              <FoldRule title="standalone · never folded into a run" tools={[...STANDALONE_TOOLS]} />
              <FoldRule title="agent row · any run length" tools={SPAWN_TOOL_NAMES} />
              <FoldRule title="hidden · never rendered" tools={[...HIDDEN_TOOLS]} />
              <div style={{ "margin-top": "7px", color: "rgba(255,255,255,0.24)" }}>
                Everything else — text, reasoning, question, permission, mcp, file, patch — renders standalone and
                flushes any open run. Source: part-groups.ts
              </div>
            </div>
          </section>
        </div>

        <footer
          style={{
            "border-top": `0.5px solid ${PANEL_LINE}`,
            padding: "10px 14px",
            display: "flex",
            "flex-direction": "column",
            gap: "8px",
          }}
        >
          <div style={{ display: "flex", gap: "6px" }}>
            <button
              type="button"
              onPointerDown={() => setHolding(true)}
              onPointerUp={() => setHolding(false)}
              onPointerLeave={() => setHolding(false)}
              style={{
                flex: "1",
                padding: "7px",
                border: `0.5px solid ${holding() ? SIGNAL : PANEL_LINE}`,
                background: holding() ? SIGNAL : "transparent",
                color: holding() ? "#181203" : PANEL_TEXT,
                cursor: "pointer",
                "font-family": "var(--font-family-mono)",
                "font-size": "10px",
                "letter-spacing": "0.04em",
              }}
            >
              hold: shipped
            </button>
          </div>
          <button
            type="button"
            disabled={changeCount() === 0}
            onClick={() => {
              setState({ ...SHIPPED, session: state.session })
              setTypography({})
            }}
            style={{
              padding: "9px",
              border: `0.5px solid ${changeCount() ? SIGNAL : PANEL_LINE}`,
              background: changeCount() ? "rgba(224,169,74,0.12)" : "transparent",
              color: changeCount() ? SIGNAL : "rgba(255,255,255,0.22)",
              cursor: changeCount() ? "pointer" : "default",
              "font-family": "var(--font-family-mono)",
              "font-size": "10.5px",
              "letter-spacing": "0.04em",
            }}
          >
            {changeCount() ? `↺ reset to current app (${changeCount()})` : "↺ at current app"}
          </button>
          <button
            type="button"
            onClick={() => setShowDiff((value) => !value)}
            style={{
              padding: "7px",
              border: `0.5px solid ${PANEL_LINE}`,
              background: "transparent",
              color: changeCount() ? SIGNAL : PANEL_DIM,
              cursor: "pointer",
              "font-family": "var(--font-family-mono)",
              "font-size": "10px",
              "text-align": "left",
            }}
          >
            {showDiff() ? "▾" : "▸"} {changeCount()} change{changeCount() === 1 ? "" : "s"} vs shipped
          </button>
          <Show when={showDiff()}>
            <div
              style={{
                "max-height": "220px",
                "overflow-y": "auto",
                "font-family": "var(--font-family-mono)",
                "font-size": "9.5px",
                "line-height": "1.6",
              }}
            >
              <Show
                when={changeCount()}
                fallback={<div style={{ color: PANEL_DIM }}>Rendering the shipped app verbatim.</div>}
              >
                <Show when={typographyChanges().length}>
                  <div style={{ "margin-bottom": "8px" }}>
                    <div style={{ color: SIGNAL }}>typography: {typographyChanges().join(", ")}</div>
                    <div style={{ color: "rgba(255,255,255,0.3)" }}>Transcript typography (dev), rail account menu</div>
                  </div>
                </Show>
                <For each={changed()}>
                  {(lever) => (
                    <div style={{ "margin-bottom": "8px" }}>
                      <div style={{ color: SIGNAL }}>
                        {lever.label}: {String(SHIPPED[lever.key])} → {String(effective()[lever.key])}
                      </div>
                      <div style={{ color: "rgba(255,255,255,0.3)" }}>{lever.origin}</div>
                    </div>
                  )}
                </For>
                <pre
                  style={{
                    "white-space": "pre-wrap",
                    "word-break": "break-all",
                    color: "rgba(255,255,255,0.42)",
                    margin: "6px 0 0",
                    padding: "7px",
                    background: "rgba(255,255,255,0.04)",
                  }}
                >
                  {overrides() || "/* no overrides */"}
                </pre>
              </Show>
            </div>
          </Show>
        </footer>
      </aside>

      <main id="tl-stage" style={{ flex: "1", "min-width": "0", "overflow-y": "auto" }}>
        <DialogProvider>
        <DataProvider
          data={data()}
          directory="/Users/yashvardhansingh/test/opencode"
          resolveSubagents={resolveSubagents}
        >
          <FileComponentProvider component={FileStub}>
            <div
              class="tl-column"
              data-slot="session-turn-list"
            >
              <For each={userMessages()}>
                {(message) => (
                  <div class="tl-turn" style={{ width: "100%" }}>
                    <SessionTurn
                      sessionID={session()?.sessionID ?? "lab"}
                      messageID={message.id}
                      messages={messages()}
                      active={effective().liveTurn === "running" && message.id === lastUserID()}
                      status={
                        effective().liveTurn === "running" && message.id === lastUserID()
                          ? { type: "busy" }
                          : { type: "idle" }
                      }
                      showReasoningSummaries={effective().machinery === "thinking"}
                      foldSettledTurn={effective().turnFold !== "off"}
                      foldRunningTurn={effective().turnFold !== "off"}
                      shellToolDefaultOpen={effective().machinery === "expanded"}
                      editToolDefaultOpen={effective().machinery === "expanded"}
                      classes={{
                        root: "min-w-0 w-full relative",
                        content: "flex flex-col justify-between !overflow-visible",
                        container: "w-full",
                      }}
                    />
                  </div>
                )}
              </For>
            </div>
          </FileComponentProvider>
        </DataProvider>
        </DialogProvider>
      </main>
    </div>
  )
}

export default {
  title: "Playground/Transcript lab",
  id: "playground-transcript-lab",
  parameters: { layout: "fullscreen" },
}

export const Lab = {
  render: () => <TranscriptLab />,
}
