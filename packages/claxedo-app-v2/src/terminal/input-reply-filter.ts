const MODE_REPORT = /^\x1b\[[?0-9;]*\$y$/
const DA_REPLY = /^\x1b\[(?:\?|>)[0-9;]+c$/
const DCS_REPORT = /^\x1bP[01][+$]r[\s\S]*(?:\x1b\\|\x07)$/
const OSC_COLOR_REPORT = /^\x1b\]1[0-2];/

function stringTerminator(chunk: string, from: number): number {
  for (let i = from; i < chunk.length; i++) {
    const code = chunk.charCodeAt(i)
    if (code === 0x07) return i
    if (code === 0x1b && chunk.charCodeAt(i + 1) === 0x5c) return i + 1
  }
  return -1
}

function csiTerminator(chunk: string, from: number): number {
  for (let i = from; i < chunk.length; i++) {
    const code = chunk.charCodeAt(i)
    if (code >= 0x40 && code <= 0x7e) return i
  }
  return -1
}

function suppressString(kind: string, sequence: string): boolean {
  if (kind === "P") return DCS_REPORT.test(sequence)
  return OSC_COLOR_REPORT.test(sequence)
}

function suppressCsi(sequence: string): boolean {
  return sequence === "\x1b[I" || sequence === "\x1b[O" || MODE_REPORT.test(sequence) || DA_REPLY.test(sequence)
}

export function stripTerminalReplies(chunk: string): string {
  if (!chunk.includes("\x1b")) return chunk
  let out = ""
  let i = 0
  while (i < chunk.length) {
    const char = chunk[i]
    const next = chunk[i + 1]
    if (char !== "\x1b" || next === undefined) {
      out += char
      i += 1
      continue
    }
    if (next === "P" || next === "]") {
      const end = stringTerminator(chunk, i + 2)
      if (end === -1) return out + chunk.slice(i)
      const sequence = chunk.slice(i, end + 1)
      if (!suppressString(next, sequence)) out += sequence
      i = end + 1
      continue
    }
    if (next !== "[") {
      out += char
      i += 1
      continue
    }
    const end = csiTerminator(chunk, i + 2)
    if (end === -1) return out + chunk.slice(i)
    const sequence = chunk.slice(i, end + 1)
    if (!suppressCsi(sequence)) out += sequence
    i = end + 1
  }
  return out
}
