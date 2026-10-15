import type { OwnedProcess } from "../contract"

const TAIL_LENGTH = 2_000
const REASON_LENGTH = 300
const ANSI = /\x1b\[[0-9;]*m/g

export function stderrReason(stderr: string): string | undefined {
  const line = stderr.replace(ANSI, "").split(/\r?\n/).map((text) => text.trim()).filter(Boolean).at(-1)
  return line?.slice(0, REASON_LENGTH)
}

export class StderrTail {
  private text = ""

  constructor(process: OwnedProcess) {
    process.stderr.setEncoding("utf8")
    process.stderr.on("data", (chunk: string) => { this.text = `${this.text}${chunk.replace(ANSI, "")}`.slice(-TAIL_LENGTH) })
  }

  get value(): string { return this.text.trim() }
}
