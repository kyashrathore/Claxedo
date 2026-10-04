import { utf8ByteLength } from "@claxedo/helpers/string"
import {
  TASKS_BOUNDS,
  type ConfigurationSlot,
  type HarnessReference,
  type ModelConfiguration,
  type ModelReference,
  type Preset,
  type PresetPlacement,
  type Task,
  type SessionLiveness,
} from "./contracts"
import { refuse, refuseInvalid } from "./errors"
import { hashRequest } from "./hash"
import { configurationEntries } from "./presets/model"

/**
 * The host-neutral half of Start: the origin key two clients must converge on,
 * the one instruction block a session is created with, the first user message,
 * and the digest a preview is revalidated against. Every host bridge composes
 * the same bytes from here, because two bridges that each rendered their own
 * instruction block would drift the moment either was edited.
 */

export const START_ORIGIN_PREFIX = "tasks.v1"

/**
 * The one attempt number a slot accepts next. The current attempt while its
 * session is live, which is the idempotent re-request; one past it once the
 * owner reports the session gone; 1 for a slot nothing has run in.
 */
export function admissibleAttempt(current: { attempt: number; liveness: SessionLiveness } | undefined): number {
  if (!current) return 1
  return current.liveness === "live" ? current.attempt : current.attempt + 1
}

/**
 * `tasks.v1:<scope>:<task>:<slot>:<attempt>`, with each supplied segment
 * percent-encoded: an id carrying a colon would otherwise render the same
 * string as a different origin, and two tasks would share one reservation.
 */
export function startOriginId(scopeId: string, taskId: string, slot: ConfigurationSlot, attempt: number): string {
  if (scopeId.length === 0 || taskId.length === 0) refuseInvalid("An origin needs a scope and a task", [])
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    refuseInvalid("An attempt is a positive whole number", [{ path: "attempt", reason: "out_of_range" }])
  }
  return [START_ORIGIN_PREFIX, encodeURIComponent(scopeId), encodeURIComponent(taskId), slot, attempt].join(":")
}

export type StartInstructionsInput = {
  preset: Preset
  slot: ConfigurationSlot
  /** The previous session rendered by the runtime's handoff transaction, when Continue was chosen. */
  handoffTranscript?: string | null
}

export type StartInstructions = {
  text: string
  configuration: ModelConfiguration
  /** Bytes the caps forced out. Non-zero is something a preview should say out loud. */
  instructionsBytesDropped: number
  transcriptBytesDropped: number
}

/** Room for one truncation marker, subtracted once per section that can be cut. */
const MARKER_RESERVE = 120

function describeConfiguration(configuration: ModelConfiguration): string {
  const effort = configuration.effort === null ? "effort: not set" : `effort: ${configuration.effort}`
  return `${configuration.harness.id} (${configuration.harness.access}), ${configuration.model.providerID}/${configuration.model.modelID}, ${effort}`
}

function describePlacement(placement: PresetPlacement): string {
  return placement === "local"
    ? "local — this session uses the host's own skills and plugins"
    : "cloud — this session uses an isolated workspace with the preset's selected capabilities"
}

/**
 * The group as settings, never as a promise of automation: naming the other
 * configurations does not make them reachable, and the selected plugins and
 * skills are deliberately absent — the host materializes those, and a list in
 * prose would claim tools that a failed projection never supplied.
 */
function describeGroup(preset: Preset, slot: ConfigurationSlot, configuration: ModelConfiguration): string {
  const others = configurationEntries(preset)
    .map(([name, entry]) => `- ${name}${name === slot ? " (running now)" : ""}: ${describeConfiguration(entry)}`)
    .join("\n")
  return [
    "## How this session is configured",
    `Placement: ${describePlacement(preset.execution.placement)}`,
    `Running configuration: ${slot} — ${describeConfiguration(configuration)}`,
    "",
    "Configurations saved on this preset:",
    others,
    "",
    "Starting another configuration is the user's action, not this session's; nothing here switches models on its own.",
  ].join("\n")
}

export type StartModelGroupEntry = {
  harness: HarnessReference
  model: ModelReference
  /** Absent where the preset set none, so the model's own default stands. */
  effort?: string
}

export type StartModelGroup = Partial<Record<ConfigurationSlot, StartModelGroupEntry>>

/**
 * The same group `describeGroup` renders as prose, in the shape a session
 * retains. A delegation naming a slot resolves it from here; reading it back
 * out of the prose would resolve whatever the sentence happened to look like.
 */
export function startModelGroup(preset: Preset): StartModelGroup {
  const group: StartModelGroup = {}
  for (const [slot, configuration] of configurationEntries(preset)) {
    group[slot] = {
      harness: configuration.harness,
      model: configuration.model,
      ...(configuration.effort === null ? {} : { effort: configuration.effort }),
    }
  }
  return group
}

/** Cuts on a character boundary: a byte slice through a multi-byte sequence decodes to U+FFFD. */
function truncateUtf8(value: string, maxBytes: number, keep: "head" | "tail"): { text: string; dropped: number } {
  const bytes = new TextEncoder().encode(value)
  if (bytes.length <= maxBytes) return { text: value, dropped: 0 }
  if (maxBytes <= 0) return { text: "", dropped: bytes.length }
  const decoder = new TextDecoder()
  if (keep === "head") {
    let end = maxBytes
    while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1
    return { text: decoder.decode(bytes.subarray(0, end)), dropped: bytes.length - end }
  }
  let start = bytes.length - maxBytes
  while (start < bytes.length && (bytes[start] ?? 0) >= 0x80 && (bytes[start] ?? 0) < 0xc0) start += 1
  return { text: decoder.decode(bytes.subarray(start)), dropped: start }
}

/**
 * One bounded block: the preset's instructions, the resolved group, then the
 * previous session last. The transcript yields first and keeps its tail, since
 * the newest turns are the ones a handoff is for; only if the instructions and
 * the group alone exceed the cap do the instructions lose their tail, and both
 * losses are reported rather than hidden.
 */
export function startInstructions(input: StartInstructionsInput): StartInstructions {
  const configuration = input.preset.configurations[input.slot]
  if (!configuration) {
    refuseInvalid(`Preset ${input.preset.id} has no ${input.slot} configuration`, [{ path: "slot", reason: "unknown_value" }])
  }

  const cap = TASKS_BOUNDS.instructionsMaxBytes
  const group = describeGroup(input.preset, input.slot, configuration)
  const groupBytes = utf8ByteLength(group)
  if (groupBytes + MARKER_RESERVE > cap) refuse("unsupported", "The resolved group does not fit an instruction block")

  const transcript = (input.handoffTranscript ?? "").trim()
  const heading = "## The previous session for this slot"
  // A transcript claims its heading and marker up front, so the instructions
  // yield the room the section will need instead of overflowing into it.
  const transcriptOverhead = transcript.length === 0 ? 0 : utf8ByteLength(heading) + MARKER_RESERVE + 4
  const written = input.preset.instructions.trim()
  const instructions = truncateUtf8(written, cap - groupBytes - MARKER_RESERVE - transcriptOverhead, "head")
  const head = [
    ...(instructions.text.length > 0 ? [instructions.text] : []),
    ...(instructions.dropped > 0 ? [`[preset instructions truncated: ${instructions.dropped} bytes dropped]`] : []),
    group,
  ].join("\n\n")

  if (transcript.length === 0) {
    return {
      text: head,
      configuration,
      instructionsBytesDropped: instructions.dropped,
      transcriptBytesDropped: 0,
    }
  }

  const overhead = utf8ByteLength(head) + utf8ByteLength(heading) + MARKER_RESERVE + 4
  const kept = truncateUtf8(transcript, cap - overhead, "tail")
  const body = [
    ...(kept.dropped > 0 ? [`[earlier turns dropped: ${kept.dropped} bytes]`] : []),
    ...(kept.text.length > 0 ? [kept.text] : []),
  ].join("\n\n")
  const text = [head, heading, body].join("\n\n")

  // The reserve makes this unreachable; exceeding the cap silently would hand
  // the harness a block it refuses at submission instead of here.
  if (utf8ByteLength(text) > cap) refuse("unsupported", "The instruction block exceeded its cap after composition")

  return {
    text,
    configuration,
    instructionsBytesDropped: instructions.dropped,
    transcriptBytesDropped: kept.dropped,
  }
}

export type StartFirstMessageInput = {
  task: Task
  /** What the user typed in the start dialog; it is their text, never a rendered transcript. */
  handoffText?: string | null
}

/** The first user message: the task in the user's own words, and nothing the host invented. */
export function startFirstMessage(input: StartFirstMessageInput): string {
  const handoff = (input.handoffText ?? "").trim()
  return [
    input.task.title.trim(),
    ...(input.task.description.trim().length > 0 ? [input.task.description.trim()] : []),
    ...(handoff.length > 0 ? [`## Where to pick up\n${handoff}`] : []),
  ].join("\n\n")
}

export type StartDigestInput = {
  scopeId: string
  taskId: string
  taskRevision: number
  presetId: string
  presetRevision: number
  slot: ConfigurationSlot
  attempt: number
  placement: PresetPlacement
  configuration: ModelConfiguration
  instructions: string
}

/**
 * What a preview resolved to. Start recomputes it and refuses a digest that no
 * longer matches, so a model, an effort or an instruction block that moved
 * between preview and Start is a refusal rather than a silent substitution.
 */
export function startDigest(input: StartDigestInput): Promise<string> {
  return hashRequest({
    scopeId: input.scopeId,
    taskId: input.taskId,
    taskRevision: input.taskRevision,
    presetId: input.presetId,
    presetRevision: input.presetRevision,
    slot: input.slot,
    attempt: input.attempt,
    placement: input.placement,
    harness: input.configuration.harness,
    model: input.configuration.model,
    effort: input.configuration.effort,
    instructions: input.instructions,
  })
}

/**
 * Which configuration a slot's session runs, as one comparable value: the
 * resolved model settings and the preset's own instruction block.
 *
 * A continued session's transcript is deliberately outside it. The digest
 * names an origin's reservation and travels on the stored link, and a Continue
 * that lost its response has to recover its own reservation on a retry — a
 * digest that moved with the rendered transcript would refuse that retry
 * instead, while still failing to distinguish two presets.
 */
export async function startConfigurationDigest(input: { preset: Preset; slot: ConfigurationSlot }): Promise<string> {
  const composed = startInstructions({ preset: input.preset, slot: input.slot, handoffTranscript: null })
  return hashRequest({
    placement: input.preset.execution.placement,
    harness: composed.configuration.harness,
    model: composed.configuration.model,
    effort: composed.configuration.effort,
    instructions: composed.text,
  })
}
