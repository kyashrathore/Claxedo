import { Show, type Component } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Select } from "@opencode-ai/ui/select"
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
  type TranscriptTypography,
} from "@opencode-ai/ui/theme/transcript-typography"
import { useSettings } from "@/platform/settings/provider"
import { SettingsList, SettingsRow } from "@/features/settings/ui/list"

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

type FaceOption = { value: TranscriptFace | "auto"; label: string; group?: string }
type EnumKnob = "headingScale" | "proseColor" | "inlineCode" | "rules"
type EnumOption = { value: string; label: string }
type NumberOption = { value: number | "auto"; label: string }
type NumericKnob = {
  [K in keyof TranscriptTypography]-?: TranscriptTypography[K] extends number | undefined ? K : never
}[keyof TranscriptTypography]

const previewFamily = (face: TranscriptFace | "auto") => (face === "auto" ? "inherit" : transcriptFaceFamily(face))

const faceLabel = (face: TranscriptFace) =>
  face === "system" ? "UI font" : face === "sfmono" ? "Code font" : TRANSCRIPT_FACES[face].label

function faceOptions(kinds: TranscriptFaceKind[]): FaceOption[] {
  const faces = kinds.flatMap((kind) =>
    transcriptFacesOfKind(kind).map((face) => ({ value: face, label: faceLabel(face), group: KIND_LABEL[kind] })),
  )
  return [{ value: "auto", label: FOLLOW_PAIRING }, ...faces]
}

function numberOptions(auto: string, values: readonly number[], unit: string): NumberOption[] {
  const numbers = values.map((value) => ({ value, label: `${value}${unit}` }))
  return [{ value: "auto", label: auto }, ...numbers]
}

const PAIRING_OPTIONS = TRANSCRIPT_PAIRING_KEYS.map((value) => ({ value, label: TRANSCRIPT_PAIRINGS[value].label }))
function enumOptions(values: readonly string[], labels: Record<string, string>): EnumOption[] {
  const named = values.map((value) => ({ value, label: labels[value] ?? value }))
  return [{ value: "auto", label: FOLLOW_PAIRING }, ...named]
}

const ENUM_ROWS: { key: EnumKnob; title: string; description: string; options: EnumOption[] }[] = [
  {
    key: "headingScale",
    title: "Heading scale",
    description: "h1/h2/h3 sizes; flat renders every heading at body size",
    options: enumOptions(TRANSCRIPT_HEADING_SCALE_KEYS, HEADING_SCALE_LABEL),
  },
  {
    key: "proseColor",
    title: "Prose colour",
    description: "Which text token prose is set in; shipped is strong",
    options: enumOptions(TRANSCRIPT_PROSE_COLORS, { strong: "Strong (shipped)", base: "Base", weak: "Weak" }),
  },
  {
    key: "inlineCode",
    title: "Inline code",
    description: "Pill is tint + hairline ring + medium; each step strips a layer",
    options: enumOptions(TRANSCRIPT_INLINE_CODE, {
      pill: "Pill (shipped)",
      tint: "Tint, no ring",
      quiet: "Mono only",
      plain: "Plain text",
    }),
  },
  {
    key: "rules",
    title: "Horizontal rule",
    description: "A model-authored --- is 32px of nothing when hidden",
    options: enumOptions(TRANSCRIPT_RULES, { hidden: "Hidden (shipped)", visible: "1px hairline" }),
  },
]
const BODY_FACES = faceOptions(["serif", "sans", "mono"])
const HEADING_FACES = faceOptions(["sans", "serif", "mono"])
const MONO_FACES = faceOptions(["mono"])

const NUMERIC_ROWS: { key: NumericKnob; title: string; description: string; options: NumberOption[] }[] = [
  {
    key: "fontSize",
    title: "Text size",
    description: "Body size of assistant prose",
    options: numberOptions(FOLLOW_PAIRING, [13, 13.5, 14, 14.5, 15, 15.5, 16, 17, 18], " px"),
  },
  {
    key: "lineHeight",
    title: "Line height",
    description: "Leading of assistant prose, relative to its text size",
    options: numberOptions(FOLLOW_PAIRING, [1.35, 1.4, 1.45, 1.5, 1.55, 1.6, 1.65, 1.7, 1.8, 1.9], ""),
  },
  {
    key: "tracking",
    title: "Tracking",
    description: "Letter spacing of assistant prose",
    options: numberOptions(FOLLOW_PAIRING, [-0.3, -0.2, -0.13, -0.1, -0.08, -0.05, 0, 0.05, 0.1, 0.15], " px"),
  },
  {
    key: "inlineCodeSize",
    title: "Inline code size",
    description: "Inline code relative to the prose beside it",
    options: numberOptions(FOLLOW_PAIRING, [0.75, 0.8, 0.85, 0.9, 0.95, 1], " em"),
  },
  {
    key: "codeFontSize",
    title: "Code block size",
    description: "Fenced code blocks",
    options: numberOptions(FOLLOW_PAIRING, [11, 12, 12.5, 13, 13.5, 14, 15, 16], " px"),
  },
  {
    key: "paragraphGap",
    title: "Paragraph gap",
    description: "Space below each paragraph",
    options: numberOptions(FOLLOW_PAIRING, [0, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28], " px"),
  },
  {
    key: "blockGap",
    title: "Block gap",
    description: "Space after lists, quotes and code blocks; shipped is 12/16/24",
    options: numberOptions(FOLLOW_PAIRING, [0, 6, 8, 10, 12, 14, 16, 18, 20, 24, 32], " px"),
  },
  {
    key: "listGap",
    title: "List item gap",
    description: "Space between list items",
    options: numberOptions(FOLLOW_PAIRING, [0, 2, 4, 6, 8, 10, 12], " px"),
  },
  {
    key: "listIndent",
    title: "List indent",
    description: "Left padding of a top-level list; ordered lists get 4px more",
    options: numberOptions(FOLLOW_PAIRING, [16, 20, 23, 24, 28, 32, 36, 40], " px"),
  },
  {
    key: "bodyWeight",
    title: "Body weight",
    description: "Weight of everything in the transcript that is not bold",
    options: numberOptions(FOLLOW_PAIRING, [350, 380, 400, 430, 450, 480, 500], ""),
  },
  {
    key: "boldWeight",
    title: "Bold weight",
    description: "Weight of strong text against the body",
    options: numberOptions(FOLLOW_PAIRING, [400, 450, 500, 550, 600, 650, 700, 800], ""),
  },
  {
    key: "measure",
    title: "Line length",
    description: "Width of the transcript column; the shipped column is 48rem, 880px from 2xl",
    options: numberOptions(FOLLOW_PAIRING, [48, 56, 60, 64, 68, 72, 76, 84, 96, 110], " ch"),
  },
]

const selectProps = {
  variant: "secondary",
  size: "small",
  triggerVariant: "settings",
  triggerStyle: { "min-width": "220px" },
} as const

const FaceSelect: Component<{
  action: string
  options: FaceOption[]
  current: TranscriptFace | undefined
  onSelect: (face: TranscriptFace | undefined) => void
}> = (props) => (
  <Select
    {...selectProps}
    data-action={props.action}
    options={props.options}
    current={props.options.find((option) => option.value === (props.current ?? "auto"))}
    value={(option) => option.value}
    label={(option) => option.label}
    groupBy={(option) => option.group ?? ""}
    onSelect={(option) => option && props.onSelect(option.value === "auto" ? undefined : option.value)}
  >
    {(option) => <span style={{ "font-family": previewFamily(option?.value ?? "auto") }}>{option?.label}</span>}
  </Select>
)

const NumberSelect: Component<{
  action: string
  options: NumberOption[]
  current: number | undefined
  onSelect: (value: number | undefined) => void
}> = (props) => (
  <Select
    {...selectProps}
    data-action={props.action}
    options={props.options}
    current={props.options.find((option) => option.value === (props.current ?? "auto"))}
    value={(option) => String(option.value)}
    label={(option) => option.label}
    onSelect={(option) => option && props.onSelect(option.value === "auto" ? undefined : option.value)}
  />
)

const kebab = (key: string) => key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)

/** The Select hands back a string; the catalogue guards in `normalize` turn it into the knob's own type. */
const enumPatch = (key: EnumKnob, value: string): Partial<TranscriptTypography> => {
  if (value === "auto") return { [key]: undefined }
  const { [key]: accepted } = normalizeTranscriptTypography({ pairing: "default", [key]: value })
  return { [key]: accepted }
}

/**
 * A knob for choosing the transcript typography that ships, not a product
 * setting: dev builds only, English only, and the chosen values are meant to
 * become the defaults in `@opencode-ai/ui/theme/transcript-typography` and
 * `session-ui/src/components/markdown.css`.
 */
export const TranscriptTypographySection: Component = () => {
  const settings = useSettings()
  const transcript = () => settings.appearance.transcript()
  const override = (patch: Partial<Omit<TranscriptTypography, "pairing">>) =>
    settings.appearance.setTranscriptOverride(patch)
  return (
    <Show when={import.meta.env.DEV}>
      <div class="flex flex-col gap-1" data-component="transcript-typography-section">
        <div class="flex items-center justify-between gap-4 pb-2">
          <h3 class="text-14-medium text-text-strong">Transcript typography (dev)</h3>
          <Button
            data-action="settings-transcript-reset"
            variant="secondary"
            size="small"
            disabled={transcript().pairing === "default" && Object.keys(transcript()).length === 1}
            onClick={() => settings.appearance.setTranscriptPairing("default")}
          >
            Reset to shipped
          </Button>
        </div>

        <SettingsList>
          <SettingsRow
            title="Pairing"
            description="Cursor and Codex are measured from their bundles; picking one clears the overrides"
          >
            <Select
              {...selectProps}
              data-action="settings-transcript-pairing"
              options={PAIRING_OPTIONS}
              current={PAIRING_OPTIONS.find((option) => option.value === transcript().pairing)}
              value={(option) => option.value}
              label={(option) => option.label}
              onSelect={(option) => option && settings.appearance.setTranscriptPairing(option.value)}
            >
              {(option) => (
                <span style={{ "font-family": previewFamily(option ? TRANSCRIPT_PAIRINGS[option.value].body : "auto") }}>
                  {option?.label}
                </span>
              )}
            </Select>
          </SettingsRow>

          <SettingsRow title="Body face" description="Prose, tool rows and your own messages">
            <FaceSelect
              action="settings-transcript-body-face"
              options={BODY_FACES}
              current={transcript().body}
              onSelect={(body) => override({ body })}
            />
          </SettingsRow>

          <SettingsRow title="Heading face" description="Headings in assistant prose">
            <FaceSelect
              action="settings-transcript-heading-face"
              options={HEADING_FACES}
              current={transcript().heading}
              onSelect={(heading) => override({ heading })}
            />
          </SettingsRow>

          <SettingsRow title="Code face" description="Inline code and code blocks">
            <FaceSelect
              action="settings-transcript-mono-face"
              options={MONO_FACES}
              current={transcript().mono}
              onSelect={(mono) => override({ mono })}
            />
          </SettingsRow>

          {ENUM_ROWS.map((row) => (
            <SettingsRow title={row.title} description={row.description}>
              <Select
                {...selectProps}
                data-action={`settings-transcript-${kebab(row.key)}`}
                options={row.options}
                current={row.options.find((option) => option.value === (transcript()[row.key] ?? "auto"))}
                value={(option) => option.value}
                label={(option) => option.label}
                onSelect={(option) => option && override(enumPatch(row.key, option.value))}
              />
            </SettingsRow>
          ))}

          {NUMERIC_ROWS.map((row) => (
            <SettingsRow title={row.title} description={row.description}>
              <NumberSelect
                action={`settings-transcript-${kebab(row.key)}`}
                options={row.options}
                current={transcript()[row.key]}
                onSelect={(value) => override({ [row.key]: value })}
              />
            </SettingsRow>
          ))}
        </SettingsList>
      </div>
    </Show>
  )
}
