import z from "zod/v3"
import { rec } from "../json-value"

export const TERMINAL_SCROLLBACK_ROWS = 5000

// State omitted by SerializeAddon. Screen bytes, geometry and stream cursor
// belong to the enclosing checkpoint and must be restored before this state.
const coordinate = z.number().int().min(0).max(10_000_000)
const charset = z.record(z.string().max(8), z.string().max(8)).nullable()
const attributes = z.object({
  fg: z.number().int(),
  bg: z.number().int(),
  extended: z.object({ _ext: z.number().int(), _urlId: coordinate }),
})
const bufferState = z.object({
  x: coordinate,
  y: coordinate,
  ybase: coordinate,
  scrollTop: coordinate,
  scrollBottom: coordinate,
  savedX: coordinate,
  savedY: coordinate,
  savedCharset: charset,
  savedCharsets: z.array(charset).max(4),
  savedGlevel: z.number().int().min(0).max(3),
  savedOriginMode: z.boolean(),
  savedWraparoundMode: z.boolean(),
  tabs: z.record(z.string().regex(/^\d+$/), z.boolean()),
  savedCurAttrData: attributes,
})

export const terminalCheckpointStateSchema = z.object({
  buffers: z.object({ normal: bufferState, alt: bufferState }),
  charset: z.object({ charsets: z.array(charset).max(4), glevel: z.number().int().min(0).max(3) }),
  stringDecoderInterim: z.union([z.literal(0), z.number().int().min(0xd800).max(0xdbff)]),
})

export type TerminalCheckpointState = z.infer<typeof terminalCheckpointStateSchema>
export const terminalCheckpointSchema = z.object({
  version: z.literal(1),
  cols: coordinate.min(2),
  rows: coordinate.min(1),
  screen: z.string().max(16_777_216),
  continuation: z.string().max(1_048_576),
  state: terminalCheckpointStateSchema,
}).superRefine((checkpoint, context) => {
  for (const [name, buffer] of Object.entries(checkpoint.state.buffers)) {
    if (buffer.x > checkpoint.cols || buffer.y >= checkpoint.rows
      || buffer.scrollTop > buffer.scrollBottom || buffer.scrollBottom >= checkpoint.rows) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["state", "buffers", name], message: "Checkpoint state exceeds its screen geometry" })
    }
  }
})
export type TerminalCheckpoint = z.infer<typeof terminalCheckpointSchema>
type BufferState = TerminalCheckpointState["buffers"]["normal"]

function internals(terminal: unknown) {
  const core = rec(rec(terminal)?._core)
  const buffers = rec(core?.buffers)
  const normal = rec(buffers?.normal)
  const alt = rec(buffers?.alt)
  const charsetService = rec(core?._charsetService)
  const decoder = rec(rec(core?._inputHandler)?._stringDecoder)
  const reset = charsetService?.reset
  const setgCharset = charsetService?.setgCharset
  const setgLevel = charsetService?.setgLevel
  if (!normal || !alt || !charsetService || !decoder
    || typeof reset !== "function"
    || typeof setgCharset !== "function"
    || typeof setgLevel !== "function") {
    throw new Error("Pinned xterm checkpoint internals are unavailable")
  }
  return { buffers: { normal, alt }, charsetService, decoder, reset, setgCharset, setgLevel }
}

function readBuffer(buffer: Record<string, unknown>): BufferState {
  // xterm uses undefined for its default charset; JSON transport uses null.
  return bufferState.parse({
    ...buffer,
    savedCharset: buffer.savedCharset ?? null,
    savedCharsets: Array.isArray(buffer.savedCharsets)
      ? buffer.savedCharsets.map((entry) => entry ?? null)
      : buffer.savedCharsets,
  })
}

export function captureTerminalCheckpointState(terminal: unknown): TerminalCheckpointState {
  const state = internals(terminal)
  return terminalCheckpointStateSchema.parse({
    buffers: { normal: readBuffer(state.buffers.normal), alt: readBuffer(state.buffers.alt) },
    charset: {
      charsets: Array.isArray(state.charsetService.charsets)
        ? state.charsetService.charsets.map((entry) => entry ?? null)
        : state.charsetService.charsets,
      glevel: state.charsetService.glevel,
    },
    stringDecoderInterim: state.decoder._interim,
  })
}

export function applyTerminalCheckpointState(terminal: unknown, input: unknown): void {
  // Validate the entire incoming state and destination before mutating either
  // buffer. A malformed checkpoint must not leave a partially restored screen.
  const checkpoint = terminalCheckpointStateSchema.parse(input)
  captureTerminalCheckpointState(terminal)
  const target = internals(terminal)
  const cols = coordinate.parse(rec(terminal)?.cols)
  const rows = coordinate.parse(rec(terminal)?.rows)
  for (const buffer of Object.values(checkpoint.buffers)) {
    if (cols < 2 || rows < 1 || buffer.x > cols || buffer.y >= rows
      || buffer.scrollTop > buffer.scrollBottom || buffer.scrollBottom >= rows) {
      throw new Error("Terminal checkpoint state does not fit the restored geometry")
    }
  }
  const destinations = (["normal", "alt"] as const).map((name) => {
    const buffer = target.buffers[name]
    const current = readBuffer(buffer)
    const attrs = rec(buffer.savedCurAttrData)
    const extended = rec(attrs?.extended)
    if (!attrs || !extended) throw new Error("Pinned xterm saved attributes are unavailable")
    return { buffer, current, attrs, extended, source: checkpoint.buffers[name] }
  })
  for (const { buffer, current, attrs, extended, source } of destinations) {
    const { ybase, savedY, savedCurAttrData, savedCharsets, savedCharset, ...values } = source
    Object.assign(buffer, values, {
      savedY: Math.max(0, savedY - ybase + current.ybase),
      savedCharset: savedCharset ?? undefined,
      savedCharsets: savedCharsets.map((entry) => entry ?? undefined),
    })
    // Retain xterm's AttributeData/ExtendedAttrs instances and their methods.
    attrs.fg = savedCurAttrData.fg
    attrs.bg = savedCurAttrData.bg
    Object.assign(extended, savedCurAttrData.extended)
  }
  const service = target.charsetService
  // Method shapes were checked by internals; invoke with their native receiver.
  Reflect.apply(target.reset, service, [])
  checkpoint.charset.charsets.forEach((entry, index) => {
    Reflect.apply(target.setgCharset, service, [index, entry ?? undefined])
  })
  Reflect.apply(target.setgLevel, service, [checkpoint.charset.glevel])
  target.decoder._interim = checkpoint.stringDecoderInterim
}
