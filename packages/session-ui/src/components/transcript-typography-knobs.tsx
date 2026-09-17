import { For, Show, type Component, type JSX } from "solid-js"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import {
  TRANSCRIPT_FACES,
  TRANSCRIPT_HEADING_SCALE_KEYS,
  TRANSCRIPT_INLINE_CODE,
  TRANSCRIPT_PAIRING_KEYS,
  TRANSCRIPT_PAIRINGS,
  TRANSCRIPT_PROSE_COLORS,
  TRANSCRIPT_RULES,
  normalizeTranscriptTypography,
  transcriptFaceFamily,
  transcriptFacesOfKind,
  type TranscriptFace,
  type TranscriptFaceKind,
  type TranscriptHeadingScale,
  type TranscriptPairing,
  type TranscriptTypography,
} from "@opencode-ai/ui/theme/transcript-typography"

const AUTO = "auto"
const THEME = "theme"
const FOLLOW_PAIRING = "Follow pairing"
const KIND_LABEL: Record<TranscriptFaceKind, string> = { sans: "Sans", serif: "Serif", mono: "Mono" }
const HEADING_SCALE_LABEL: Record<TranscriptHeadingScale, string> = {
  flat: "Flat (shipped)",
  subtle: "Subtle 17/15/14",
  clear: "Clear 21/17/15",
  editorial: "Editorial 25/19/15",
  cursor: "Cursor 17/17/16",
  codex: "Codex 21/17.5/15.75",
}

type Auto = typeof AUTO
type Theme = typeof THEME
type Choice<V extends string> = { value: V; label: string; group?: string; family?: string }
type ChoiceGroup<V extends string> = { group: string | undefined; choices: Choice<V>[] }
type EnumKnob = "headingScale" | "proseColor" | "inlineCode" | "rules"
type NumericKnob = {
  [K in keyof TranscriptTypography]-?: TranscriptTypography[K] extends number | undefined ? K : never
}[keyof TranscriptTypography]

export type TranscriptTypographyOverride = Partial<Omit<TranscriptTypography, "pairing">>

const faceLabel = (face: TranscriptFace) =>
  face === "system" ? "UI font" : face === "sfmono" ? "Code font" : TRANSCRIPT_FACES[face].label

function faceChoices(kinds: TranscriptFaceKind[]): Choice<TranscriptFace | Auto>[] {
  const faces = kinds.flatMap((kind) =>
    transcriptFacesOfKind(kind).map((face) => ({
      value: face,
      label: faceLabel(face),
      group: KIND_LABEL[kind],
      family: transcriptFaceFamily(face),
    })),
  )
  return [{ value: AUTO, label: FOLLOW_PAIRING }, ...faces]
}

function numberChoices(values: readonly number[], unit: string): Choice<string>[] {
  const numbers = values.map((value) => ({ value: String(value), label: `${value}${unit}` }))
  return [{ value: AUTO, label: FOLLOW_PAIRING }, ...numbers]
}

function enumChoices(values: readonly string[], labels: Record<string, string>): Choice<string>[] {
  const named = values.map((value) => ({ value, label: labels[value] ?? value }))
  return [{ value: AUTO, label: FOLLOW_PAIRING }, ...named]
}

const PAIRING_CHOICES: Choice<TranscriptPairing | Theme>[] = [
  { value: THEME, label: "Theme's" },
  ...TRANSCRIPT_PAIRING_KEYS.map((value) => ({
    value,
    label: TRANSCRIPT_PAIRINGS[value].label,
    family: transcriptFaceFamily(TRANSCRIPT_PAIRINGS[value].body),
  })),
]
const BODY_FACES = faceChoices(["serif", "sans", "mono"])
const HEADING_FACES = faceChoices(["sans", "serif", "mono"])
const MONO_FACES = faceChoices(["mono"])

const ENUM_ROWS: { key: EnumKnob; title: string; choices: Choice<string>[] }[] = [
  { key: "headingScale", title: "Heading scale", choices: enumChoices(TRANSCRIPT_HEADING_SCALE_KEYS, HEADING_SCALE_LABEL) },
  {
    key: "proseColor",
    title: "Prose colour",
    choices: enumChoices(TRANSCRIPT_PROSE_COLORS, { strong: "Strong (shipped)", base: "Base", weak: "Weak" }),
  },
  {
    key: "inlineCode",
    title: "Inline code",
    choices: enumChoices(TRANSCRIPT_INLINE_CODE, {
      pill: "Pill (shipped)",
      tint: "Tint, no ring",
      quiet: "Mono only",
      plain: "Plain text",
    }),
  },
  { key: "rules", title: "Horizontal rule", choices: enumChoices(TRANSCRIPT_RULES, { hidden: "Hidden (shipped)", visible: "1px hairline" }) },
]

const NUMERIC_ROWS: { key: NumericKnob; title: string; choices: Choice<string>[] }[] = [
  { key: "fontSize", title: "Text size", choices: numberChoices([13, 13.5, 14, 14.5, 15, 15.5, 16, 17, 18], " px") },
  { key: "lineHeight", title: "Line height", choices: numberChoices([1.35, 1.4, 1.45, 1.5, 1.55, 1.6, 1.65, 1.7, 1.8, 1.9], "") },
  { key: "tracking", title: "Tracking", choices: numberChoices([-0.3, -0.2, -0.13, -0.1, -0.08, -0.05, 0, 0.05, 0.1, 0.15], " px") },
  { key: "inlineCodeSize", title: "Inline code size", choices: numberChoices([0.75, 0.8, 0.85, 0.9, 0.95, 1], " em") },
  { key: "codeFontSize", title: "Code block size", choices: numberChoices([11, 12, 12.5, 13, 13.5, 14, 15, 16], " px") },
  { key: "paragraphGap", title: "Paragraph gap", choices: numberChoices([0, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28], " px") },
  { key: "blockGap", title: "Block gap", choices: numberChoices([0, 6, 8, 10, 12, 14, 16, 18, 20, 24, 32], " px") },
  { key: "listGap", title: "List item gap", choices: numberChoices([0, 2, 4, 6, 8, 10, 12], " px") },
  { key: "listIndent", title: "List indent", choices: numberChoices([16, 20, 23, 24, 28, 32, 36, 40], " px") },
  { key: "bodyWeight", title: "Body weight", choices: numberChoices([350, 380, 400, 430, 450, 480, 500], "") },
  { key: "boldWeight", title: "Bold weight", choices: numberChoices([400, 450, 500, 550, 600, 650, 700, 800], "") },
  { key: "measure", title: "Line length", choices: numberChoices([48, 56, 60, 64, 68, 72, 76, 84, 96, 110], " ch") },
]

const kebab = (key: string) => key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)

/** The catalogue guards in `normalize` turn the picked string into the knob's own type. */
const enumPatch = (key: EnumKnob, value: string): TranscriptTypographyOverride => {
  if (value === AUTO) return { [key]: undefined }
  const { [key]: accepted } = normalizeTranscriptTypography({ [key]: value })
  return { [key]: accepted }
}

function groupChoices<V extends string>(choices: Choice<V>[]): ChoiceGroup<V>[] {
  const groups: ChoiceGroup<V>[] = []
  for (const choice of choices) {
    const last = groups[groups.length - 1]
    if (last && last.group === choice.group) last.choices.push(choice)
    else groups.push({ group: choice.group, choices: [choice] })
  }
  return groups
}

const CHOICES_STYLE = { "max-height": "calc(100vh - 24px)", "overflow-y": "auto" } as const
const ROW_CLASS =
  "w-full flex items-center gap-2 h-7 px-2.5 rounded-md text-compact leading-4 text-text-base/80 hover:text-text-base hover:bg-surface-base-hover/35 data-[expanded]:bg-surface-base-hover data-[expanded]:text-text-strong"

/** Kobalte reports the picked value as `unknown`; resolving it back to a choice is what keeps `onChange` typed. */
function Knob<V extends string>(props: {
  action: string
  label: string
  choices: Choice<V>[]
  value: V
  /** Replaces the chosen option's label beside the row, e.g. to name what a "theme" choice resolves to. */
  detail?: string
  onChange: (value: V) => void
  onOpenChange?: (open: boolean) => void
}): JSX.Element {
  const find = (value: unknown) => props.choices.find((choice) => choice.value === value)
  const pick = (value: unknown) => {
    const choice = find(value)
    if (choice) props.onChange(choice.value)
  }
  return (
    <DropdownMenu placement="right-start" gutter={6} onOpenChange={props.onOpenChange}>
      <DropdownMenu.Trigger data-action={props.action} aria-label={props.label} class={ROW_CLASS}>
        <span class="min-w-0 flex-1 truncate text-left">{props.label}</span>
        <span class="min-w-0 truncate text-text-weak">{props.detail ?? find(props.value)?.label}</span>
        <Icon name="chevron-right" size="small" class="shrink-0 opacity-30" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="z-[220] min-w-[200px]" style={CHOICES_STYLE}>
          <DropdownMenu.RadioGroup value={props.value} onChange={pick}>
            <For each={groupChoices(props.choices)}>
              {(group) => (
                <DropdownMenu.Group>
                  <Show when={group.group}>{(label) => <DropdownMenu.GroupLabel>{label()}</DropdownMenu.GroupLabel>}</Show>
                  <For each={group.choices}>
                    {(choice) => (
                      <DropdownMenu.RadioItem value={choice.value} closeOnSelect={false}>
                        <span class="flex-1" style={{ "font-family": choice.family ?? "inherit" }}>{choice.label}</span>
                        <DropdownMenu.ItemIndicator>
                          <span class="text-text-weak/50">&#10003;</span>
                        </DropdownMenu.ItemIndicator>
                      </DropdownMenu.RadioItem>
                    )}
                  </For>
                </DropdownMenu.Group>
              )}
            </For>
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}

/**
 * Every knob of a `TranscriptTypography`, one dropdown row each, for choosing the
 * typography that ships: the app's dev-only rail panel and the transcript lab story
 * are the two hosts, and each keeps the record and the transcript it re-renders.
 * The pairing row clears every override when it changes; the others each set one.
 */
export const TranscriptTypographyKnobs: Component<{
  value: TranscriptTypography
  /** Names what the "Theme's" pairing resolves to, shown while no pairing is stored. */
  pairingDetail?: string
  onPairing: (pairing: TranscriptPairing | undefined) => void
  onOverride: (patch: TranscriptTypographyOverride) => void
  onMenuOpenChange?: (open: boolean) => void
}> = (props) => {
  const face = (key: "body" | "heading" | "mono", value: TranscriptFace | Auto) =>
    props.onOverride({ [key]: value === AUTO ? undefined : value })
  const number = (key: NumericKnob, value: string) => props.onOverride({ [key]: value === AUTO ? undefined : Number(value) })
  return (
    <>
      <Knob
        action="settings-transcript-pairing"
        label="Pairing"
        choices={PAIRING_CHOICES}
        value={props.value.pairing ?? THEME}
        detail={props.value.pairing ? undefined : props.pairingDetail}
        onChange={(pairing) => props.onPairing(pairing === THEME ? undefined : pairing)}
        onOpenChange={props.onMenuOpenChange}
      />
      <Knob
        action="settings-transcript-body-face"
        label="Body face"
        choices={BODY_FACES}
        value={props.value.body ?? AUTO}
        onChange={(value) => face("body", value)}
        onOpenChange={props.onMenuOpenChange}
      />
      <Knob
        action="settings-transcript-heading-face"
        label="Heading face"
        choices={HEADING_FACES}
        value={props.value.heading ?? AUTO}
        onChange={(value) => face("heading", value)}
        onOpenChange={props.onMenuOpenChange}
      />
      <Knob
        action="settings-transcript-mono-face"
        label="Code face"
        choices={MONO_FACES}
        value={props.value.mono ?? AUTO}
        onChange={(value) => face("mono", value)}
        onOpenChange={props.onMenuOpenChange}
      />
      <For each={ENUM_ROWS}>
        {(row) => (
          <Knob
            action={`settings-transcript-${kebab(row.key)}`}
            label={row.title}
            choices={row.choices}
            value={props.value[row.key] ?? AUTO}
            onChange={(value) => props.onOverride(enumPatch(row.key, value))}
            onOpenChange={props.onMenuOpenChange}
          />
        )}
      </For>
      <For each={NUMERIC_ROWS}>
        {(row) => (
          <Knob
            action={`settings-transcript-${kebab(row.key)}`}
            label={row.title}
            choices={row.choices}
            value={props.value[row.key] === undefined ? AUTO : String(props.value[row.key])}
            onChange={(value) => number(row.key, value)}
            onOpenChange={props.onMenuOpenChange}
          />
        )}
      </For>
    </>
  )
}
