import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import {
  toolNameAliases,
  type AgentContentPart,
  type AgentPresentationMessage,
} from "@claxedo/agent-runtime-contract"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import {
  TRANSCRIPT_FACES,
  TRANSCRIPT_PAIRING_KEYS,
  TRANSCRIPT_PAIRINGS,
  isTranscriptPairing,
  resolveTranscriptTypography,
  transcriptFacesOfKind,
  transcriptTypographyStyle,
  type TranscriptFace,
  type TranscriptHeadingScale,
  type TranscriptInlineCode,
  type TranscriptPairing,
  type TranscriptRules,
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
import { FileStub } from "./story-stubs"
import type { SubagentView } from "../context/data"
import { TRANSCRIPT_LAB_SESSIONS, type TranscriptLabSession } from "./transcript-lab-fixture"

type LabState = {
  session: string
  layout: "legacy" | "v2"
  headings: TranscriptHeadingScale
  boldWeight: number
  rules: TranscriptRules
  turnSeparator: "none" | "hairline" | "numbered"
  inlineCode: TranscriptInlineCode
  inlineCodeSize: number
  measure: string
  lineHeight: number
  paraGap: number
  listIndent: "shipped" | "uniform24" | "uniform20"
  pairing: TranscriptPairing
  bodyFace: TranscriptFace | "auto"
  headingFace: TranscriptFace | "auto"
  monoFace: TranscriptFace | "auto"
  fontSize: number
  tracking: number
  mutedLift: number
  machinery: "shipped" | "thinking" | "expanded" | "prose"
  rowGap: number
  proseLeadIn: number
  turnFold: "off" | "tools"
  liveTurn: "settled" | "running"
  toolOutput: "shipped" | "boxed" | "scrollbar"
  errorCard: "shipped" | "hairline" | "quiet"
}

/**
 * Every value here is what the shipped Claxedo app renders today, so the lab opens at
 * parity and each control is a deliberate departure. `machinery: "shipped"` encodes
 * settings default `showReasoningSummaries: false`
 * (claxedo-app/src/platform/settings/provider.tsx:116).
 */
const SHIPPED: LabState = {
  session: TRANSCRIPT_LAB_SESSIONS[0]?.id ?? "",
  layout: "legacy",
  headings: "flat",
  boldWeight: 600,
  rules: "hidden",
  turnSeparator: "none",
  inlineCode: "pill",
  inlineCodeSize: 0.8,
  measure: "shipped",
  lineHeight: 1.6,
  paraGap: 6,
  listIndent: "shipped",
  pairing: "default",
  bodyFace: "auto",
  headingFace: "auto",
  monoFace: "auto",
  fontSize: 14,
  tracking: 0,
  mutedLift: 0,
  machinery: "shipped",
  rowGap: 12,
  proseLeadIn: 24,
  turnFold: "tools",
  liveTurn: "settled",
  toolOutput: "shipped",
  errorCard: "shipped",
}


type Muted = { weak: string; weaker: string }

type Control =
  | { kind: "segment"; options: { value: string; label: string }[] }
  | { kind: "select"; options: { value: string; label: string }[] }
  | { kind: "range"; min: number; max: number; step: number; unit: string }

type Lever = {
  key: keyof LabState
  group: string
  label: string
  finding: string
  origin: string
  control: Control
  css: (state: LabState, muted: Muted | undefined) => string
  apply?: (value: string, state: LabState) => Partial<LabState>
}

const SCOPE = "#tl-stage"

/** The app's own transcript geometry: message-timeline.tsx:1415-1420 plus its `px-5` rows. */
const BASE_CSS = [
  `${SCOPE} .tl-column{width:100%;max-width:var(--transcript-measure,48rem);margin-inline:auto;padding-inline:20px;`,
  `padding-block:28px 64px;display:flex;flex-direction:column}`,
  `@media (min-width:1536px){${SCOPE} .tl-column{max-width:var(--transcript-measure,880px)}}`,
].join("")

/** The app applies the same declarations inline on its timeline root; the lab writes them as a rule. */
function typographyCss(s: LabState) {
  const resolved = resolveTranscriptTypography({
    pairing: s.pairing,
    ...(s.bodyFace === "auto" ? {} : { body: s.bodyFace }),
    ...(s.headingFace === "auto" ? {} : { heading: s.headingFace }),
    ...(s.monoFace === "auto" ? {} : { mono: s.monoFace }),
    fontSize: s.fontSize,
    lineHeight: s.lineHeight,
    tracking: s.tracking,
    inlineCodeSize: s.inlineCodeSize,
    paragraphGap: s.paraGap,
    boldWeight: s.boldWeight,
    headingScale: s.headings,
    inlineCode: s.inlineCode,
    rules: s.rules,
    ...(s.listIndent === "shipped" ? {} : { listIndent: s.listIndent === "uniform24" ? 24 : 20 }),
    ...(s.measure === "shipped" ? {} : { measure: Number(s.measure) }),
  })
  const declarations = Object.entries(transcriptTypographyStyle(resolved))
    .map(([property, value]) => `${property}:${value}`)
    .join(";")
  return `${SCOPE}{${declarations}}`
}

const LEVERS: Lever[] = [
  {
    key: "layout",
    group: "Structure",
    label: "Style branch",
    finding: "The app never sets data-new-layout, so half the transcript CSS never ships.",
    origin: "storybook/.storybook/preview.tsx:51 is the only writer in the repo",
    control: {
      kind: "segment",
      options: [
        { value: "legacy", label: "legacy" },
        { value: "v2", label: "v2" },
      ],
    },
    css: () => "",
  },
  {
    key: "headings",
    group: "Hierarchy",
    label: "Heading scale",
    finding: "Legacy collapses h1–h6 to 14px/500 — identical pixels to a bold span.",
    origin: "ui/src/theme/transcript-typography.ts TRANSCRIPT_HEADING_SCALES",
    control: {
      kind: "segment",
      options: [
        { value: "flat", label: "flat" },
        { value: "subtle", label: "subtle" },
        { value: "clear", label: "clear" },
        { value: "editorial", label: "editorial" },
      ],
    },
    css: () => "",
  },
  {
    key: "boldWeight",
    group: "Hierarchy",
    label: "Bold weight",
    finding: "600 against a 400 body. At 500 the emphasis was near the perceptual floor on a UI font.",
    origin: "markdown.css:78-80",
    control: { kind: "range", min: 400, max: 800, step: 10, unit: "" },
    css: () => "",
  },
  {
    key: "rules",
    group: "Hierarchy",
    label: "Horizontal rule",
    finding: "hr is height:0 — a model-authored --- renders as 32px of nothing.",
    origin: "markdown.css:168-172",
    control: {
      kind: "segment",
      options: [
        { value: "hidden", label: "invisible" },
        { value: "visible", label: "visible" },
      ],
    },
    css: () => "",
  },
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
    key: "inlineCode",
    group: "Prose texture",
    label: "Inline code",
    finding: "Five treatments at once (mono, weight, padding, radius, ring, tint) on 3.6 spans per 100 words.",
    origin: "markdown.css:352-366",
    control: {
      kind: "segment",
      options: [
        { value: "pill", label: "pill" },
        { value: "tint", label: "tint" },
        { value: "quiet", label: "quiet" },
        { value: "plain", label: "plain" },
      ],
    },
    css: () => "",
  },
  {
    key: "inlineCodeSize",
    group: "Prose texture",
    label: "Inline code size",
    finding: "0.8em via --font-size-inline-code. At 1em the mono ran larger than the prose beside it.",
    origin: "ui/src/styles/theme.css:34",
    control: { kind: "range", min: 0.8, max: 1, step: 0.01, unit: "em" },
    css: () => "",
  },
  {
    key: "measure",
    group: "Measure & rhythm",
    label: "Line length",
    finding: "768px (880px at 2xl) is ~100–120 characters; user bubbles already use 64ch.",
    origin: "message-timeline.tsx:1415-1420 vs message-part.css:132-136",
    control: {
      kind: "segment",
      options: [
        { value: "shipped", label: "768/880px" },
        { value: "56", label: "56ch" },
        { value: "64", label: "64ch" },
        { value: "68", label: "68ch" },
        { value: "76", label: "76ch" },
      ],
    },
    css: () => "",
  },
  {
    key: "lineHeight",
    group: "Measure & rhythm",
    label: "Line height",
    finding: "1.6 on a 14px UI font at a 110ch measure.",
    origin: "Settings → General → Transcript line height",
    control: { kind: "range", min: 1.35, max: 1.9, step: 0.05, unit: "" },
    css: () => "",
  },
  {
    key: "paraGap",
    group: "Measure & rhythm",
    label: "Paragraph gap",
    finding: "6px. Spacing is the only structure prose has, so the values need to stay distinguishable.",
    origin: "markdown.css:84-86",
    control: { kind: "range", min: 6, max: 28, step: 1, unit: "px" },
    css: () => "",
  },
  {
    key: "listIndent",
    group: "Measure & rhythm",
    label: "List indent",
    finding: "Level 1 indents 32px, the nested level only 16px — nesting shrinks the step.",
    origin: "markdown.css:105-110 vs :146-152",
    control: {
      kind: "segment",
      options: [
        { value: "shipped", label: "32 / 16" },
        { value: "uniform24", label: "24 / 24" },
        { value: "uniform20", label: "20 / 20" },
      ],
    },
    css: () => "",
  },
  {
    key: "pairing",
    group: "Type",
    label: "Pairing",
    finding: "Sets body, heading and mono faces plus size, leading and tracking together.",
    origin: "ui/src/theme/transcript-typography.ts, Settings → General → Transcript typography",
    control: {
      kind: "segment",
      options: TRANSCRIPT_PAIRING_KEYS.map((key) => ({ value: key, label: TRANSCRIPT_PAIRINGS[key].label })),
    },
    apply: (value) => {
      if (!isTranscriptPairing(value)) return {}
      const preset = TRANSCRIPT_PAIRINGS[value]
      return {
        pairing: value,
        bodyFace: "auto",
        headingFace: "auto",
        monoFace: "auto",
        fontSize: preset.size,
        lineHeight: preset.lineHeight,
        tracking: preset.tracking,
      }
    },
    css: (s) => typographyCss(s),
  },
  {
    key: "bodyFace",
    group: "Type",
    label: "Body face",
    finding: "The transcript is set in the OS UI font, drawn for labels rather than reading.",
    origin: "Settings → General → Transcript body face",
    control: {
      kind: "select",
      options: [
        { value: "auto", label: `follow pairing` },
        ...transcriptFacesOfKind("serif").map((key) => ({ value: key, label: `serif · ${TRANSCRIPT_FACES[key].label}` })),
        ...transcriptFacesOfKind("sans").map((key) => ({ value: key, label: `sans · ${TRANSCRIPT_FACES[key].label}` })),
        ...transcriptFacesOfKind("mono").map((key) => ({ value: key, label: `mono · ${TRANSCRIPT_FACES[key].label}` })),
      ],
    },
    css: () => "",
  },
  {
    key: "headingFace",
    group: "Type",
    label: "Heading face",
    finding: "Headings share the body face today, so a scale change is the only signal.",
    origin: "Settings → General → Transcript heading face",
    control: {
      kind: "select",
      options: [
        { value: "auto", label: `follow pairing` },
        ...transcriptFacesOfKind("sans").map((key) => ({ value: key, label: `sans · ${TRANSCRIPT_FACES[key].label}` })),
        ...transcriptFacesOfKind("serif").map((key) => ({ value: key, label: `serif · ${TRANSCRIPT_FACES[key].label}` })),
        ...transcriptFacesOfKind("mono").map((key) => ({ value: key, label: `mono · ${TRANSCRIPT_FACES[key].label}` })),
      ],
    },
    css: () => "",
  },
  {
    key: "monoFace",
    group: "Type",
    label: "Mono face",
    finding: "Drives inline code and every fenced block.",
    origin: "Settings → General → Transcript code face",
    control: {
      kind: "select",
      options: [
        { value: "auto", label: `follow pairing` },
        ...transcriptFacesOfKind("mono").map((key) => ({ value: key, label: TRANSCRIPT_FACES[key].label })),
      ],
    },
    css: () => "",
  },
  {
    key: "fontSize",
    group: "Type",
    label: "Body size",
    finding: "14px.",
    origin: "Settings → General → Transcript text size",
    control: { kind: "range", min: 13, max: 18, step: 0.5, unit: "px" },
    css: () => "",
  },
  {
    key: "tracking",
    group: "Type",
    label: "Tracking",
    finding: "Prose sets none; --letter-spacing-chat (-0.13px) exists and is never applied here.",
    origin: "ui/src/styles/theme.css:88",
    control: { kind: "range", min: -0.3, max: 0.15, step: 0.01, unit: "px" },
    css: () => "",
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

function Picker(props: {
  options: { value: string; label: string }[]
  value: string
  dirty: boolean
  onSelect: (value: string) => void
}) {
  return (
    <select
      value={props.value}
      onChange={(event) => props.onSelect(event.currentTarget.value)}
      style={{
        width: "100%",
        padding: "5px 6px",
        border: `0.5px solid ${props.dirty ? SIGNAL : PANEL_LINE}`,
        background: PANEL_BG,
        color: props.dirty ? SIGNAL : "#d8d8d8",
        cursor: "pointer",
        "font-family": "var(--font-family-mono)",
        "font-size": "10px",
      }}
    >
      <For each={props.options}>{(option) => <option value={option.value}>{option.label}</option>}</For>
    </select>
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
  const setLever = (lever: Lever, value: string | number) => {
    if (lever.apply && typeof value === "string") {
      setState(lever.apply(value, state))
      return
    }
    setState(lever.key, value)
  }
  const [holding, setHolding] = createSignal(false)
  const [showDiff, setShowDiff] = createSignal(false)
  const [themeTick, setThemeTick] = createSignal(0)

  const effective = createMemo<LabState>(() =>
    holding() ? { ...SHIPPED, session: state.session } : { ...state },
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

  /* The preview decorator mirrors an app.tsx body class that no longer exists, so the lab
     strips it to render at true app parity and restores it for the rest of Storybook. */
  onMount(() => {
    const stripped = ["font-(family-name:--font-family-text)", "text-[13px]", "font-[440]"].filter((name) =>
      document.body.classList.contains(name),
    )
    for (const name of stripped) document.body.classList.remove(name)
    onCleanup(() => {
      for (const name of stripped) document.body.classList.add(name)
      document.body.toggleAttribute("data-new-layout", true)
    })
  })

  createEffect(() => {
    document.body.toggleAttribute("data-new-layout", effective().layout === "v2")
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
    LEVERS.map((lever) => lever.css(effective(), muted()))
      .filter(Boolean)
      .join("\n"),
  )

  const css = createMemo(() => `${BASE_CSS}\n${overrides()}`)

  const changed = createMemo(() =>
    LEVERS.filter((lever) => effective()[lever.key] !== SHIPPED[lever.key]),
  )

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
                          <Match when={lever.control.kind === "select" ? lever.control : undefined}>
                            {(control) => (
                              <Picker
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
            disabled={changed().length === 0}
            onClick={() => setState({ ...SHIPPED, session: state.session })}
            style={{
              padding: "9px",
              border: `0.5px solid ${changed().length ? SIGNAL : PANEL_LINE}`,
              background: changed().length ? "rgba(224,169,74,0.12)" : "transparent",
              color: changed().length ? SIGNAL : "rgba(255,255,255,0.22)",
              cursor: changed().length ? "pointer" : "default",
              "font-family": "var(--font-family-mono)",
              "font-size": "10.5px",
              "letter-spacing": "0.04em",
            }}
          >
            {changed().length ? `↺ reset to current app (${changed().length})` : "↺ at current app"}
          </button>
          <button
            type="button"
            onClick={() => setShowDiff((value) => !value)}
            style={{
              padding: "7px",
              border: `0.5px solid ${PANEL_LINE}`,
              background: "transparent",
              color: changed().length ? SIGNAL : PANEL_DIM,
              cursor: "pointer",
              "font-family": "var(--font-family-mono)",
              "font-size": "10px",
              "text-align": "left",
            }}
          >
            {showDiff() ? "▾" : "▸"} {changed().length} change{changed().length === 1 ? "" : "s"} vs shipped
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
                when={changed().length}
                fallback={<div style={{ color: PANEL_DIM }}>Rendering the shipped app verbatim.</div>}
              >
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
